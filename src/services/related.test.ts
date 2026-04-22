import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { RelatedService } from './related'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return join(dir, 'index.db')
}

describe('RelatedService', () => {
  test('finds related unit nodes from shared symbols and same-zone proximity', async () => {
    const dbPath = makeTempDbPath('code-spider-related')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'zone', 'zone:src', 'src', 'src', null, 0.8, 1),
         (2, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript', 0.7, 1),
         (3, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts', 'TypeScript', 0.6, 1),
         (4, 1, 'unit', 'unit:tests/a.test.ts', 'a.test.ts', 'tests/a.test.ts', 'TypeScript', 0.4, 1)`
    ).run()

    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value)
       VALUES
         (1, 2, 'loc', 10), (1, 2, 'churn', 1), (1, 2, 'recency', 1),
         (1, 3, 'loc', 12), (1, 3, 'churn', 1), (1, 3, 'recency', 1),
         (1, 4, 'loc', 8), (1, 4, 'churn', 1), (1, 4, 'recency', 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES
         (1, 1, 2, 'src/a.ts:ExampleService', 'ExampleService', 'Class', null, null, null, null, null),
         (2, 1, 3, 'src/b.ts:ExampleService', 'ExampleService', 'Class', null, null, null, null, null),
         (3, 1, 4, 'tests/a.test.ts:ExampleService', 'ExampleService', 'Class', null, null, null, null, null),
         (4, 1, 2, 'src/a.ts:helperThing', 'helperThing', 'Function', null, null, null, null, null),
         (5, 1, 3, 'src/b.ts:helperThing', 'helperThing', 'Function', null, null, null, null, null)`
    ).run()

    const related = await new RelatedService(db, 1, '/tmp/repo').getRelated('unit:src/a.ts', 5)

    expect(related.length).toBeGreaterThan(0)
    expect(related[0]?.key).toBe('unit:src/b.ts')
    expect(related[0]?.reasons.some(reason => reason.includes('shared symbols'))).toBe(true)
    expect(related[0]?.reasons.some(reason => reason.includes('same zone'))).toBe(true)
  })

  test('finds related zones from shared symbols across zones', async () => {
    const dbPath = makeTempDbPath('code-spider-related-zones')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'zone', 'zone:src', 'src', 'src', null, 0.8, 1),
         (2, 1, 'zone', 'zone:tests', 'tests', 'tests', null, 0.5, 1),
         (3, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript', 0.7, 1),
         (4, 1, 'unit', 'unit:tests/a.test.ts', 'a.test.ts', 'tests/a.test.ts', 'TypeScript', 0.4, 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES
         (1, 1, 3, 'src/a.ts:ExampleService', 'ExampleService', 'Class', null, null, null, null, null),
         (2, 1, 4, 'tests/a.test.ts:ExampleService', 'ExampleService', 'Class', null, null, null, null, null)`
    ).run()

    const related = await new RelatedService(db, 1, '/tmp/repo').getRelated('zone:src', 5)

    expect(related).toEqual([
      {
        key: 'zone:tests',
        label: 'tests',
        path: 'tests',
        score: 1,
        reasons: ['1 shared symbols', 'shared: ExampleService'],
      },
    ])
  })

  test('uses shared markdown sections as a relatedness signal', async () => {
    const dbPath = makeTempDbPath('code-spider-related-markdown')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'zone', 'zone:src', 'src', 'src', null, 0.8, 1),
         (2, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript', 0.7, 1),
         (3, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts', 'TypeScript', 0.6, 1),
         (4, 1, 'doc', 'doc:README.md', 'README.md', 'README.md', 'Markdown', 0, 0.8),
         (5, 1, 'doc_section', 'doc_section:README.md#overview', 'Overview', 'README.md', 'Markdown', 0, 0.7)`
    ).run()

    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value)
       VALUES
         (1, 2, 'loc', 10), (1, 2, 'churn', 1), (1, 2, 'recency', 1),
         (1, 3, 'loc', 12), (1, 3, 'churn', 1), (1, 3, 'recency', 1)`
    ).run()

    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight, metadata_json)
       VALUES
         (1, 4, 5, 'contains', 1, null),
         (1, 5, 2, 'mentions', 1, null),
         (1, 5, 3, 'mentions', 1, null)`
    ).run()

    const related = await new RelatedService(db, 1, '/tmp/repo').getRelated('unit:src/a.ts', 5)

    expect(related.length).toBeGreaterThan(0)
    expect(related[0]?.key).toBe('unit:src/b.ts')
    expect(related[0]?.reasons.some(reason => reason.includes('documented together in README.md > Overview'))).toBe(true)
  })
})
