// code-spider-ebz
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../db/init'
import { pruneRuns } from './prune'
import { Navigator } from './navigator'
import { cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

type Db = ReturnType<typeof openDb>

function seedRun(db: Db, runId: number, repoRoot: string, opts: { symbols?: boolean; embeddings?: boolean; investigation?: boolean } = {}): void {
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (?,?,?,?,?,?)'
  ).run(runId, '2026-07-08T12:00:00Z', '2026-07-08T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (?, ?, 'unit', 'unit:src/example.ts', 'example.ts', 'src/example.ts', 'TypeScript', 0, 1)`
  ).run(runId * 100, runId)
  if (opts.symbols) {
    db.query(
      `INSERT INTO symbols (id, run_id, node_id, symbol_key, name, kind)
       VALUES (?, ?, ?, 'src/example.ts:Example', 'Example', 'Class')`
    ).run(runId * 100, runId, runId * 100)
  }
  if (opts.embeddings) {
    db.query(
      `INSERT INTO embeddings (run_id, node_id, model, dims, vector) VALUES (?, ?, 'test-model', 2, ?)`
    ).run(runId, runId * 100, new Uint8Array([0, 0]))
  }
  if (opts.investigation) {
    db.query(
      `INSERT INTO investigations (run_id, title, question, status, created_at, updated_at)
       VALUES (?, 'thread', 'why?', 'open', '2026-07-08T12:00:00Z', '2026-07-08T12:00:00Z')`
    ).run(runId)
  }
}

function makeDb(repoRoot: string): Db {
  mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
  return openDb(join(repoRoot, '.code-spider', 'index.db'))
}

describe('pruneRuns', () => {
  test('deletes old runs, keeps the newest --keep runs', () => {
    const repoRoot = makeTempRepo('code-spider-prune-basic')
    const db = makeDb(repoRoot)
    for (let i = 1; i <= 5; i++) seedRun(db, i, repoRoot)

    const result = pruneRuns({ db, repoRoot, keep: 2 })

    expect(result.deletedRunIds).toEqual([1, 2, 3])
    expect(Navigator.listRunIds(db, repoRoot, 10)).toEqual([5, 4])
    const orphanNodes = db.query<{ c: number }, []>(
      'SELECT COUNT(*) AS c FROM nodes WHERE run_id IN (1,2,3)'
    ).get()
    expect(orphanNodes?.c).toBe(0)
  })

  test('protects capability-fallback and investigation runs', () => {
    const repoRoot = makeTempRepo('code-spider-prune-protect')
    const db = makeDb(repoRoot)
    seedRun(db, 1, repoRoot, { investigation: true })
    seedRun(db, 2, repoRoot, { symbols: true })
    seedRun(db, 3, repoRoot, { embeddings: true })
    seedRun(db, 4, repoRoot)
    seedRun(db, 5, repoRoot)

    const result = pruneRuns({ db, repoRoot, keep: 1 })

    // run 4 is the only unprotected run: 5 = newest+keep, 3 = newest
    // embeddings, 2 = newest symbols, 1 = investigation-referenced.
    expect(result.deletedRunIds).toEqual([4])
    expect(Navigator.resolveRunFor(db, repoRoot, 'symbols').runId).toBe(2)
    expect(Navigator.resolveRunFor(db, repoRoot, 'embeddings').runId).toBe(3)
  })

  test('dry run deletes nothing', () => {
    const repoRoot = makeTempRepo('code-spider-prune-dry')
    const db = makeDb(repoRoot)
    for (let i = 1; i <= 4; i++) seedRun(db, i, repoRoot)

    const result = pruneRuns({ db, repoRoot, keep: 1, dryRun: true })

    expect(result.deletedRunIds).toEqual([1, 2, 3])
    expect(Navigator.listRunIds(db, repoRoot, 10)).toEqual([4, 3, 2, 1])
  })
})
