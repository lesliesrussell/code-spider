import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { SemanticQueryService } from './semantic-query'

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

describe('SemanticQueryService definitions', () => {
  test('returns persisted symbol definitions with decoded locations', () => {
    const dbPath = makeTempDbPath('code-spider-defs')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/main.zig', 'main.zig', 'src/main.zig', 'Other', 0, 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      1,
      1,
      'src/main.zig:eval',
      'eval',
      'Function',
      'Runtime',
      null,
      JSON.stringify({
        start: { line: 11, character: 2 },
        end: { line: 18, character: 1 },
      }),
      JSON.stringify({
        start: { line: 11, character: 7 },
        end: { line: 11, character: 11 },
      }),
      null,
    )

    const matches = new SemanticQueryService(db, 1).findDefinitions('eval')

    expect(matches).toHaveLength(1)
    expect(matches[0]).toMatchObject({
      path: 'src/main.zig',
      name: 'eval',
      kind: 'Function',
      containerName: 'Runtime',
      line: 11,
      column: 2,
      endLine: 18,
      endColumn: 1,
      anchorLine: 11,
      anchorColumn: 7,
      heuristic: false,
    })
  })

  test('sorts concrete analyzer results ahead of heuristic matches', () => {
    const dbPath = makeTempDbPath('code-spider-defs-order')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'typescript', 0, 1),
         (2, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts', 'typescript', 0, 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      1,
      2,
      'src/b.ts:build',
      'build',
      'Function',
      null,
      null,
      JSON.stringify({ start: { line: 4, character: 0 }, end: { line: 8, character: 1 } }),
      null,
      JSON.stringify({ mode: 'heuristic' }),
    )

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      2,
      1,
      1,
      'src/a.ts:build',
      'build',
      'Function',
      null,
      null,
      JSON.stringify({ start: { line: 1, character: 0 }, end: { line: 3, character: 1 } }),
      null,
      null,
    )

    const matches = new SemanticQueryService(db, 1).findDefinitions('build')

    expect(matches).toHaveLength(2)
    expect(matches[0]?.path).toBe('src/a.ts')
    expect(matches[0]?.heuristic).toBe(false)
    expect(matches[0]?.anchorLine).toBe(1)
    expect(matches[0]?.anchorColumn).toBe(0)
    expect(matches[1]?.path).toBe('src/b.ts')
    expect(matches[1]?.heuristic).toBe(true)
  })

  test('returns indexed symbol locations as a fallback reference set', () => {
    const dbPath = makeTempDbPath('code-spider-indexed-refs')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'typescript', 0, 1),
         (2, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts', 'typescript', 0, 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      1,
      1,
      1,
      'src/a.ts:build',
      'build',
      'Function',
      null,
      null,
      JSON.stringify({ start: { line: 1, character: 0 }, end: { line: 3, character: 1 } }),
      null,
      null,
    )

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      2,
      1,
      2,
      'src/b.ts:build',
      'build',
      'Function',
      null,
      null,
      JSON.stringify({ start: { line: 5, character: 2 }, end: { line: 7, character: 1 } }),
      null,
      null,
    )

    const refs = new SemanticQueryService(db, 1).findIndexedReferences('build')

    expect(refs).toEqual([
      {
        path: 'src/a.ts',
        line: 1,
        column: 0,
        endLine: 3,
        endColumn: 1,
      },
      {
        path: 'src/b.ts',
        line: 5,
        column: 2,
        endLine: 7,
        endColumn: 1,
      },
    ])
  })

  test('returns atoms for a unit sorted by source position', () => {
    const dbPath = makeTempDbPath('code-spider-atoms')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'typescript', 0, 1)`
    ).run()

    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES
         (1, 1, 1, 'src/a.ts:later', 'later', 'Function', null, null, ?, ?, null),
         (2, 1, 1, 'src/a.ts:Earlier', 'Earlier', 'Class', null, null, ?, ?, null)`
    ).run(
      JSON.stringify({ start: { line: 10, character: 0 }, end: { line: 12, character: 1 } }),
      JSON.stringify({ start: { line: 10, character: 9 }, end: { line: 10, character: 14 } }),
      JSON.stringify({ start: { line: 1, character: 0 }, end: { line: 4, character: 1 } }),
      JSON.stringify({ start: { line: 1, character: 13 }, end: { line: 1, character: 20 } }),
    )

    const atoms = new SemanticQueryService(db, 1).findAtoms('unit:src/a.ts')

    expect(atoms.map(atom => atom.name)).toEqual(['Earlier', 'later'])
    expect(atoms[0]).toMatchObject({
      kind: 'Class',
      anchorLine: 1,
      anchorColumn: 13,
    })
    expect(atoms[1]).toMatchObject({
      kind: 'Function',
      anchorLine: 10,
      anchorColumn: 9,
    })
  })
})
