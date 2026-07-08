// code-spider-ag4
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../db/init'
import { Navigator } from './navigator'
// code-spider-5jl
import { cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function seedRun(db: ReturnType<typeof openDb>, runId: number, repoRoot: string, withSymbols: boolean): void {
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (?,?,?,?,?,?)'
  ).run(runId, '2026-07-07T12:00:00Z', '2026-07-07T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (?, ?, 'unit', 'unit:src/example.ts', 'example.ts', 'src/example.ts', 'TypeScript', 0, 1)`
  ).run(runId * 100, runId)
  if (withSymbols) {
    db.query(
      `INSERT INTO symbols (id, run_id, node_id, symbol_key, name, kind)
       VALUES (?, ?, ?, 'src/example.ts:Example', 'Example', 'Class')`
    ).run(runId * 100, runId, runId * 100)
  }
}

describe('Navigator.resolveSemanticRunId', () => {
  test('returns latest run when it has symbols', () => {
    const repoRoot = makeTempRepo('code-spider-semrun-latest')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const db = openDb(join(repoRoot, '.code-spider', 'index.db'))
    seedRun(db, 1, repoRoot, true)
    seedRun(db, 2, repoRoot, true)

    expect(Navigator.resolveSemanticRunId(db, repoRoot)).toEqual({ runId: 2, fallbackFrom: null })
  })

  test('falls back to newest run with symbols when latest has none', () => {
    const repoRoot = makeTempRepo('code-spider-semrun-fallback')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const db = openDb(join(repoRoot, '.code-spider', 'index.db'))
    seedRun(db, 1, repoRoot, true)
    seedRun(db, 2, repoRoot, false)

    expect(Navigator.resolveSemanticRunId(db, repoRoot)).toEqual({ runId: 1, fallbackFrom: 2 })
  })

  test('returns latest run without fallback when no run has symbols', () => {
    const repoRoot = makeTempRepo('code-spider-semrun-none')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const db = openDb(join(repoRoot, '.code-spider', 'index.db'))
    seedRun(db, 1, repoRoot, false)
    seedRun(db, 2, repoRoot, false)

    expect(Navigator.resolveSemanticRunId(db, repoRoot)).toEqual({ runId: 2, fallbackFrom: null })
  })

  test('returns null runId when no completed runs exist', () => {
    const repoRoot = makeTempRepo('code-spider-semrun-empty')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const db = openDb(join(repoRoot, '.code-spider', 'index.db'))

    expect(Navigator.resolveSemanticRunId(db, repoRoot)).toEqual({ runId: null, fallbackFrom: null })
  })
})
