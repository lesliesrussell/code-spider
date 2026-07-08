import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import runShow from './show'
// code-spider-5jl
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

describe('show command', () => {
  test('prints explicit context headings for docs, issues, and git history', async () => {
    const repoRoot = makeTempRepo('code-spider-show-context')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, summary, score, confidence, metadata_json)
       VALUES
         (1, 1, 'repo', 'repo:.', 'code-spider', '.', null, null, 1, 1, NULL),
         (2, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', 'Main entrypoint', 0.8, 1, NULL),
         (3, 1, 'doc', 'doc:README.md', 'README.md', 'README.md', 'Markdown', 'Guide', 0, 1, NULL),
         (4, 1, 'doc_section', 'doc_section:README.md#overview', 'Overview', 'README.md', 'Markdown', 'Explains startup', 0, 1, NULL),
         (5, 1, 'issue', 'issue:code-spider-3zr', 'Polish reports and command surfaces for context layer', 'code-spider-3zr', NULL, 'Tracks polishing', 0.9, 1, '{"status":"open"}')`
    ).run()
    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value) VALUES
         (1, 2, 'loc', 20),
         (1, 2, 'churn', 2),
         (1, 2, 'recency', 1)`
    ).run()
    db.query(
      `INSERT INTO evidence (run_id, node_id, kind, source, locator, snippet, score)
       VALUES (1, 2, 'git', 'abc1234', 'src/main.ts', 'introduce main flow', 1.0)`
    ).run()
    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight) VALUES
         (1, 3, 4, 'contains', 1),
         (1, 4, 2, 'mentions', 1),
         (1, 5, 2, 'tracked-by', 2)`
    ).run()

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

    expect(capture.lines).toContain('Summary')
    expect(capture.lines).toContain('Git Context (1)')
    expect(capture.lines).toContain('Docs Context (1)')
    expect(capture.lines).toContain('Tracked Issues (1)')
  })
})
