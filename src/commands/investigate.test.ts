import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import runInvestigate from './investigate'
// code-spider-5jl
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

describe('investigate command', () => {
  // code-spider-azy
  test('pin attaches evidence to the thread and show/export surface it', async () => {
    const repoRoot = makeTempRepo('code-spider-investigate-pin')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO investigations (id, run_id, title, question, status, summary, created_at, updated_at)
       VALUES (7, 1, 'Pin test', 'Where is the evidence?', 'open', NULL, '2026-04-22T10:03:00Z', '2026-04-22T10:03:00Z')`
    ).run()
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:main.ts', 'main.ts', 'main.ts', 'TypeScript', 0.8, 1)`
    ).run()
    db.query(
      `INSERT INTO evidence (id, run_id, node_id, kind, source, locator, snippet, score)
       VALUES (42, 1, 1, 'git', 'abc1234', 'main.ts', 'introduce runner', 1.0)`
    ).run()

    const ctx = (args: string[]): CliContext => ({
      args, repoRoot, dbPath, json: false, flags: {},
    })

    const pinCapture = captureLogs()
    try {
      await runInvestigate(ctx(['pin', '7', '42', 'key commit']))
    } finally {
      pinCapture.restore()
    }
    expect(pinCapture.lines.some(line => line.includes('Pinned evidence #42'))).toBe(true)

    const showCapture = captureLogs()
    try {
      await runInvestigate(ctx(['show', '7']))
    } finally {
      showCapture.restore()
    }
    expect(showCapture.lines.some(line => line.includes('Pinned Evidence (1)'))).toBe(true)
    expect(showCapture.lines.some(line => line.includes('#42') && line.includes('introduce runner') && line.includes('key commit'))).toBe(true)
  })

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
