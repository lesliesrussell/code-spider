// code-spider-p1d
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { HotspotAnalyzer } from './hotspots'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface SeedUnit {
  id: number
  path: string
  loc?: number
  churn?: number
}

function seedGraph(units: SeedUnit[], imports: Array<[number, number]> = []) {
  const dir = mkdtempSync(join(tmpdir(), 'hotspots-db-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language) VALUES (?, 1, 'unit', ?, ?, ?, 'TypeScript')`
  )
  const insertStat = db.prepare(`INSERT INTO stats (run_id, node_id, metric, value) VALUES (1, ?, ?, ?)`)
  for (const u of units) {
    insertNode.run(u.id, `unit:${u.path}`, u.path.split('/').pop() ?? u.path, u.path)
    insertStat.run(u.id, 'loc', u.loc ?? 10)
    insertStat.run(u.id, 'churn', u.churn ?? 0)
  }
  const insertEdge = db.prepare(
    `INSERT INTO edges (run_id, from_node_id, to_node_id, kind) VALUES (1, ?, ?, 'imports')`
  )
  for (const [from, to] of imports) insertEdge.run(from, to)
  return db
}

function addCycleFinding(db: ReturnType<typeof openDb>, paths: string[]): void {
  new FindingsStore(db, 1).add({
    ruleId: 'circular-dependency',
    category: 'cycles',
    severity: 'warning',
    confidence: 'high',
    title: 'cycle',
    summary: 'cycle',
    anchor: paths.join('|'),
    locations: paths.map(p => ({ path: p })),
  })
}

function addDupFinding(db: ReturnType<typeof openDb>, paths: [string, string]): void {
  new FindingsStore(db, 1).add({
    ruleId: 'duplicate-region',
    category: 'duplication',
    severity: 'warning',
    confidence: 'high',
    title: 'dup',
    summary: 'dup',
    anchor: paths.join('|'),
    locations: paths.map(p => ({ path: p })),
  })
}

function hotspots(db: ReturnType<typeof openDb>, ruleId = 'hotspot') {
  return new FindingsStore(db, 1).list({ ruleId })
}

describe('HotspotAnalyzer', () => {
  test('a unit hot on every signal is flagged; quiet units are not', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/hot.ts', loc: 500, churn: 20 },
        { id: 2, path: 'src/quiet.ts', loc: 50, churn: 0 },
        { id: 3, path: 'src/c.ts', loc: 60, churn: 1 },
        { id: 4, path: 'src/d.ts', loc: 40, churn: 1 },
      ],
      // hot.ts is a hub: imports and imported by everything
      [[1, 2], [1, 3], [4, 1], [3, 1], [2, 1]]
    )
    addCycleFinding(db, ['src/hot.ts', 'src/c.ts'])
    addDupFinding(db, ['src/hot.ts', 'src/d.ts'])

    new HotspotAnalyzer().analyze(db, 1)

    const found = hotspots(db)
    expect(found).toHaveLength(1)
    const f = found[0]!
    expect(f.locations[0]!.path).toBe('src/hot.ts')
    expect(f.metrics?.['composite']).toBeGreaterThan(0.5)
    expect(f.metrics?.['centrality']).toBe(1)
    expect(f.metrics?.['cycles']).toBe(1)
  })

  test('weights override changes which units qualify', () => {
    const seed = () => {
      const db = seedGraph(
        [
          { id: 1, path: 'src/churny.ts', loc: 10, churn: 50 },
          { id: 2, path: 'src/big.ts', loc: 900, churn: 0 },
          { id: 3, path: 'src/c.ts', loc: 10, churn: 1 },
        ],
        []
      )
      return db
    }
    // churn-only weighting flags the churny file, not the big one
    const db1 = seed()
    new HotspotAnalyzer().analyze(db1, 1, {
      weights: { complexity: 0, centrality: 0, churn: 1, duplication: 0, cycles: 0 },
    })
    expect(hotspots(db1).map(f => f.locations[0]!.path)).toEqual(['src/churny.ts'])

    // complexity-only weighting flags the big file instead
    const db2 = seed()
    new HotspotAnalyzer().analyze(db2, 1, {
      weights: { complexity: 1, centrality: 0, churn: 0, duplication: 0, cycles: 0 },
    })
    expect(hotspots(db2).map(f => f.locations[0]!.path)).toEqual(['src/big.ts'])
  })

  test('complexity outliers are reported separately', () => {
    const db = seedGraph([
      { id: 1, path: 'src/huge.ts', loc: 1000 },
      { id: 2, path: 'src/a.ts', loc: 100 },
      { id: 3, path: 'src/b.ts', loc: 100 },
      { id: 4, path: 'src/c.ts', loc: 100 },
    ])
    new HotspotAnalyzer().analyze(db, 1)
    const outliers = hotspots(db, 'complexity-outlier')
    expect(outliers).toHaveLength(1)
    expect(outliers[0]!.locations[0]!.path).toBe('src/huge.ts')
  })

  test('high-centrality hubs are reported separately', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/hub.ts' },
        { id: 2, path: 'src/a.ts' },
        { id: 3, path: 'src/b.ts' },
        { id: 4, path: 'src/c.ts' },
        { id: 5, path: 'src/d.ts' },
        { id: 6, path: 'src/e.ts' },
      ],
      [[2, 1], [3, 1], [4, 1], [5, 1], [1, 6]]
    )
    new HotspotAnalyzer().analyze(db, 1)
    const hubs = hotspots(db, 'high-centrality-risk')
    expect(hubs).toHaveLength(1)
    expect(hubs[0]!.locations[0]!.path).toBe('src/hub.ts')
  })

  test('non-code units (docs, config) are never scored', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hotspots-db-'))
    tempDirs.push(dir)
    const db = openDb(join(dir, 'index.db'))
    db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language) VALUES
         (1, 1, 'unit', 'unit:docs/big.md', 'big.md', 'docs/big.md', 'Markdown'),
         (2, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript'),
         (3, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts', 'TypeScript')`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 5000), (1, 2, 'loc', 100), (1, 3, 'loc', 100)`
    ).run()
    new HotspotAnalyzer().analyze(db, 1)
    expect(hotspots(db, 'complexity-outlier')).toEqual([])
    expect(hotspots(db)).toEqual([])
  })

  test('re-running is idempotent with identical fingerprints', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/hot.ts', loc: 500, churn: 20 },
        { id: 2, path: 'src/quiet.ts', loc: 50, churn: 0 },
      ],
      [[2, 1]]
    )
    addCycleFinding(db, ['src/hot.ts', 'src/quiet.ts'])
    const analyzer = new HotspotAnalyzer()
    analyzer.analyze(db, 1)
    const first = new FindingsStore(db, 1).list({ category: 'hotspots' })
    analyzer.analyze(db, 1)
    const second = new FindingsStore(db, 1).list({ category: 'hotspots' })
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
    expect(second.map(f => f.fingerprint)).toEqual(first.map(f => f.fingerprint))
  })
})
