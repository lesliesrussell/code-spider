import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import runInvestigate from './investigate'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(arg => String(arg)).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.log = originalLog
    },
  }
}

describe('investigate command', () => {
  test('shows curated context for visited nodes', async () => {
    const repoRoot = makeTempRepo('code-spider-investigate-show')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    writeFileSync(join(repoRoot, 'README.md'), '# README\n')
    writeFileSync(join(repoRoot, 'main.ts'), 'export class Runner {}\n')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO investigations (id, run_id, title, question, status, summary, created_at, updated_at)
       VALUES (3, 1, 'Runner investigation', 'How is Runner documented?', 'open', NULL, '2026-04-22T10:03:00Z', '2026-04-22T10:03:00Z')`
    ).run()
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence, metadata_json)
       VALUES
         (1, 1, 'unit', 'unit:main.ts', 'main.ts', 'main.ts', 'TypeScript', 'Runner entrypoint', 0.8, 1, NULL),
         (2, 1, 'doc', 'doc:README.md', 'README.md', 'README.md', 'Markdown', 'Repo guide', 0, 0.8, NULL),
         (3, 1, 'doc_section', 'doc_section:README.md#overview', 'Overview', 'README.md', 'Markdown', 'Runner overview', 0, 0.8, NULL),
         (4, 1, 'issue', 'issue:code-spider-8jw', 'Integrate context nodes into investigations', 'code-spider-8jw', NULL, 'Tracks investigation context', 0.9, 0.9, '{"status":"open"}')`
    ).run()
    db.query(
      `INSERT INTO investigation_nodes (investigation_id, node_id, note)
       VALUES (3, 1, 'Start here')`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 1, 'loc', 10),
         (1, 1, 'churn', 2),
         (1, 1, 'recency', 1)`
    ).run()
    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight) VALUES
         (1, 3, 1, 'mentions', 1),
         (1, 2, 3, 'contains', 1),
         (1, 4, 1, 'tracked-by', 2)`
    ).run()
    db.query(
      `INSERT INTO evidence (run_id, node_id, kind, source, locator, snippet, score)
       VALUES (1, 1, 'git', 'abc1234', 'main.ts', 'introduce runner', 1.0)`
    ).run()

    const capture = captureLogs()
    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: false,
        args: ['show', '3'],
        flags: {},
      }
      await runInvestigate(ctx)
    } finally {
      capture.restore()
    }

    expect(capture.lines.some(line => line.includes('doc: README.md :: Overview (README.md)'))).toBe(true)
    expect(capture.lines.some(line => line.includes('issue: code-spider-8jw [open] Integrate context nodes into investigations'))).toBe(true)
    expect(capture.lines.some(line => line.includes('git: abc1234 (main.ts) — introduce runner'))).toBe(true)
  })
})
