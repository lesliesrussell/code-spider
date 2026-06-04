// code-spider-cii
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { ReachabilityAnalyzer } from './reachability'
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
  language?: string
  entrypoint?: boolean
}

function seedGraph(units: SeedUnit[], imports: Array<[number, number, number?]>) {
  const dir = mkdtempSync(join(tmpdir(), 'reachability-db-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, metadata_json) VALUES (?, 1, 'unit', ?, ?, ?, ?, ?)`
  )
  for (const u of units) {
    insertNode.run(
      u.id,
      `unit:${u.path}`,
      u.path.split('/').pop() ?? u.path,
      u.path,
      u.language ?? 'TypeScript',
      u.entrypoint ? JSON.stringify({ entrypoint: true }) : null
    )
  }
  const insertEdge = db.prepare(
    `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, confidence) VALUES (1, ?, ?, 'imports', ?)`
  )
  for (const [from, to, confidence] of imports) insertEdge.run(from, to, confidence ?? 1)
  return db
}

function unusedFindings(db: ReturnType<typeof openDb>) {
  return new FindingsStore(db, 1).list({ ruleId: 'unused-file' })
}

describe('ReachabilityAnalyzer', () => {
  test('flags unreached units high-confidence; reachable units stay clean', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/used.ts' },
        { id: 3, path: 'src/dead.ts' },
      ],
      [[1, 2]]
    )
    const result = new ReachabilityAnalyzer().analyze(db, 1)
    expect(result.roots).toBe(1)
    const findings = unusedFindings(db)
    expect(findings).toHaveLength(1)
    const f = findings[0]!
    expect(f.locations[0]!.path).toBe('src/dead.ts')
    expect(f.confidence).toBe('high')
    expect(f.severity).toBe('warning')
  })

  test('units reachable only via dynamic import get a low-confidence info finding', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/lazy.ts' },
      ],
      [[1, 2, 0.5]]
    )
    new ReachabilityAnalyzer().analyze(db, 1)
    const findings = unusedFindings(db)
    expect(findings).toHaveLength(1)
    const f = findings[0]!
    expect(f.locations[0]!.path).toBe('src/lazy.ts')
    expect(f.confidence).toBe('low')
    expect(f.severity).toBe('info')
    expect(f.summary).toContain('dynamic')
  })

  test('confidence propagates as max-min over paths', () => {
    // index -> a (static) -> b (dynamic): b is weakly reachable
    // index -> b also via static c? no — single weak path only.
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/a.ts' },
        { id: 3, path: 'src/b.ts' },
        { id: 4, path: 'src/c.ts' },
      ],
      [
        [1, 2],        // static
        [2, 3, 0.5],   // weak path to b
        [1, 4],        // static
        [4, 3],        // strong path to b — wins
      ]
    )
    new ReachabilityAnalyzer().analyze(db, 1)
    // b reachable strongly via c, so nothing is flagged
    expect(unusedFindings(db)).toEqual([])
  })

  test('test files are implicit roots and keep their imports alive', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/helper.test.ts' },
        { id: 3, path: 'src/helper.ts' },
      ],
      [[2, 3]]
    )
    new ReachabilityAnalyzer().analyze(db, 1)
    expect(unusedFindings(db)).toEqual([])
  })

  test('non-import languages are never flagged', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'README.md', language: 'Markdown' },
        { id: 3, path: 'config.yaml', language: 'YAML' },
      ],
      []
    )
    new ReachabilityAnalyzer().analyze(db, 1)
    expect(unusedFindings(db)).toEqual([])
  })

  // code-spider-cii: dogfood exclusions — ambient declarations are consumed
  // by tsc without imports, and fixture files are loaded by path strings
  // from tests.
  test('declaration files and fixtures are never flagged', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/globals.d.ts' },
        { id: 3, path: 'src/adapters/fixtures/fake-server.ts' },
      ],
      []
    )
    new ReachabilityAnalyzer().analyze(db, 1)
    expect(unusedFindings(db)).toEqual([])
  })

  test('no entrypoints configured degrades to zero findings with roots=0', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/a.ts' },
        { id: 2, path: 'src/b.ts' },
      ],
      [[1, 2]]
    )
    const result = new ReachabilityAnalyzer().analyze(db, 1)
    expect(result.roots).toBe(0)
    expect(unusedFindings(db)).toEqual([])
  })

  test('re-running is idempotent with identical fingerprints', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/index.ts', entrypoint: true },
        { id: 2, path: 'src/dead.ts' },
      ],
      []
    )
    const analyzer = new ReachabilityAnalyzer()
    analyzer.analyze(db, 1)
    const first = unusedFindings(db)
    analyzer.analyze(db, 1)
    const second = unusedFindings(db)
    expect(second).toHaveLength(first.length)
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
    expect(second.map(f => f.fingerprint)).toEqual(first.map(f => f.fingerprint))
  })
})
