// code-spider-q6b
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { stronglyConnectedComponents, CycleAnalyzer } from './cycles'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('stronglyConnectedComponents', () => {
  test('acyclic graph yields no multi-node components', () => {
    const sccs = stronglyConnectedComponents([1, 2, 3], [[1, 2], [2, 3]])
    expect(sccs).toEqual([])
  })

  test('finds a trivial two-node cycle', () => {
    const sccs = stronglyConnectedComponents([1, 2, 3], [[1, 2], [2, 1], [2, 3]])
    expect(sccs).toEqual([[1, 2]])
  })

  test('finds separate components with members sorted', () => {
    const sccs = stronglyConnectedComponents(
      [5, 4, 3, 2, 1, 6],
      [[1, 2], [2, 1], [3, 4], [4, 5], [5, 3], [5, 6]]
    )
    expect(sccs).toEqual([[1, 2], [3, 4, 5]])
  })

  test('ignores self-loops', () => {
    const sccs = stronglyConnectedComponents([1, 2], [[1, 1], [1, 2]])
    expect(sccs).toEqual([])
  })

  test('handles deep chains without recursion overflow', () => {
    const n = 50_000
    const nodes = Array.from({ length: n }, (_, i) => i)
    const edges: Array<[number, number]> = []
    for (let i = 0; i < n - 1; i++) edges.push([i, i + 1])
    edges.push([n - 1, 0]) // close the loop: one giant cycle
    const sccs = stronglyConnectedComponents(nodes, edges)
    expect(sccs).toHaveLength(1)
    expect(sccs[0]).toHaveLength(n)
  })
})

interface SeedUnit {
  id: number
  path: string
  churn?: number
}

function seedGraph(units: SeedUnit[], imports: Array<[number, number]>) {
  const dir = mkdtempSync(join(tmpdir(), 'cycles-db-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, run_id, kind, key, label, path) VALUES (?, 1, 'unit', ?, ?, ?)`
  )
  const insertStat = db.prepare(`INSERT INTO stats (run_id, node_id, metric, value) VALUES (1, ?, 'churn', ?)`)
  for (const u of units) {
    insertNode.run(u.id, `unit:${u.path}`, u.path.split('/').pop() ?? u.path, u.path)
    if (u.churn !== undefined) insertStat.run(u.id, u.churn)
  }
  const insertEdge = db.prepare(
    `INSERT INTO edges (run_id, from_node_id, to_node_id, kind) VALUES (1, ?, ?, 'imports')`
  )
  for (const [from, to] of imports) insertEdge.run(from, to)
  return db
}

describe('CycleAnalyzer', () => {
  test('emits a circular-dependency finding per unit-level SCC', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts', churn: 3 },
        { id: 2, path: 'src/b.ts', churn: 4 },
        { id: 3, path: 'src/c.ts' },
      ],
      [[1, 2], [2, 1], [2, 3]]
    )
    new CycleAnalyzer().analyze(db, 1)
    const findings = new FindingsStore(db, 1).list({ ruleId: 'circular-dependency' })
    expect(findings).toHaveLength(1)
    const f = findings[0]!
    expect(f.category).toBe('cycles')
    expect(f.severity).toBe('warning')
    expect(f.locations.map(l => l.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(f.metrics?.['sccSize']).toBe(2)
    expect(f.metrics?.['totalChurn']).toBe(7)
  })

  test('acyclic graph emits zero findings', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts' },
        { id: 2, path: 'src/b.ts' },
      ],
      [[1, 2]]
    )
    new CycleAnalyzer().analyze(db, 1)
    expect(new FindingsStore(db, 1).list({ category: 'cycles' })).toEqual([])
  })

  test('cross-zone SCC also emits a package-cycle finding', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'backend/api.ts' },
        { id: 2, path: 'frontend/view.ts' },
      ],
      [[1, 2], [2, 1]]
    )
    new CycleAnalyzer().analyze(db, 1)
    const pkg = new FindingsStore(db, 1).list({ ruleId: 'package-cycle' })
    expect(pkg).toHaveLength(1)
    expect(pkg[0]!.summary).toContain('backend')
    expect(pkg[0]!.summary).toContain('frontend')
  })

  test('same-zone cycle emits no package-cycle finding', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts' },
        { id: 2, path: 'src/b.ts' },
      ],
      [[1, 2], [2, 1]]
    )
    new CycleAnalyzer().analyze(db, 1)
    expect(new FindingsStore(db, 1).list({ ruleId: 'package-cycle' })).toEqual([])
  })

  test('re-running is idempotent with identical fingerprints', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts' },
        { id: 2, path: 'src/b.ts' },
      ],
      [[1, 2], [2, 1]]
    )
    const analyzer = new CycleAnalyzer()
    analyzer.analyze(db, 1)
    const first = new FindingsStore(db, 1).list({ category: 'cycles' })
    analyzer.analyze(db, 1)
    const second = new FindingsStore(db, 1).list({ category: 'cycles' })
    expect(second).toHaveLength(first.length)
    expect(second.map(f => f.fingerprint)).toEqual(first.map(f => f.fingerprint))
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
  })

  test('records analyzer telemetry', () => {
    const db = seedGraph([{ id: 1, path: 'src/a.ts' }], [])
    new CycleAnalyzer().analyze(db, 1)
    const row = db
      .query(
        `SELECT ar.status, a.tool_name FROM analyzer_runs ar
         JOIN analyzers a ON ar.analyzer_id = a.id
         WHERE ar.run_id = 1 AND a.tool_name = 'cycles'`
      )
      .get() as { status: string; tool_name: string } | null
    expect(row?.status).toBe('success')
  })
})

// code-spider-l0m
describe('cycle evidence', () => {
  test('circular-dependency findings carry member import edges as evidence', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts' },
        { id: 2, path: 'src/b.ts' },
      ],
      [[1, 2], [2, 1]]
    )
    new CycleAnalyzer().analyze(db, 1)
    const store = new FindingsStore(db, 1)
    const finding = store.list({ ruleId: 'circular-dependency' })[0]!
    const evidence = store.getEvidence(finding.id)
    expect(evidence.map(e => e.locator).sort()).toEqual([
      'src/a.ts -> src/b.ts',
      'src/b.ts -> src/a.ts',
    ])
    expect(evidence[0]!.kind).toBe('graph')
    expect(evidence[0]!.source).toBe('imports')
  })
})
