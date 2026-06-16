// code-spider-ab9
// Guard test: read commands must record "ingested" provenance (the token-size
// of the nodes their answer drew from) into the per-process token ledger.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { getIngested, resetLedger } from '../services/token-ledger'
import runShow from './show'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  resetLedger()
})

function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function captureLogs(): { restore: () => void } {
  const originalLog = console.log
  console.log = () => {}
  return {
    restore: () => {
      console.log = originalLog
    },
  }
}

describe('read command provenance', () => {
  test('show records ingested tokens for the shown node', async () => {
    const repoRoot = makeTempRepo('code-spider-provenance')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-06-16T10:00:00Z', '2026-06-16T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence, metadata_json)
       VALUES
         (1, 1, 'repo', 'repo:.', 'code-spider', '.', null, null, 1, 1, NULL),
         (2, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Main entrypoint', 0.8, 1, NULL)`
    ).run()
    // The token ledger sums the 'tokens' stat for the resolved result nodes.
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 2, 'loc', 20),
         (1, 2, 'tokens', 512)`
    ).run()

    expect(getIngested()).toBe(0)

    const capture = captureLogs()
    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: false,
        args: ['unit:src/main.ts'],
        flags: {},
      }
      await runShow(ctx)
    } finally {
      capture.restore()
    }

    expect(getIngested()).toBeGreaterThan(0)
  })
})
