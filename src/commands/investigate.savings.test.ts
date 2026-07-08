// code-spider-ab9
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { getActiveInvestigation } from '../services/app-state'
import runInvestigate from './investigate'
// code-spider-5jl
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function seedRun(dbPath: string, repoRoot: string) {
  const db = openDb(dbPath)
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version, corpus_ingested_tokens) VALUES (1,?,?,?,?,?,?)'
  ).run('2026-04-22T10:00:00Z', '2026-04-22T10:02:00Z', repoRoot, 'abc1234', 'test', 100000)
  return db
}

describe('investigate start/end activation and savings', () => {
  test('start activates and end clears the active investigation', async () => {
    const repoRoot = makeTempRepo('code-spider-investigate-activate')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = seedRun(dbPath, repoRoot)

    const ctx = (args: string[]): CliContext => ({ args, repoRoot, dbPath, json: false, flags: {} })

    const startCapture = captureLogs()
    try {
      await runInvestigate(ctx(['start', 'why is auth slow']))
    } finally {
      startCapture.restore()
    }
    const activeId = getActiveInvestigation(db)
    expect(activeId).not.toBeNull()

    const endCapture = captureLogs()
    try {
      await runInvestigate(ctx(['end']))
    } finally {
      endCapture.restore()
    }
    expect(endCapture.lines.some(line => line.includes('Investigation tracking ended.'))).toBe(true)
    expect(getActiveInvestigation(db)).toBeNull()
  })

  test('show renders Token Savings from seeded token_events', async () => {
    const repoRoot = makeTempRepo('code-spider-investigate-savings')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = seedRun(dbPath, repoRoot)
    db.query(
      `INSERT INTO investigations (id, run_id, title, question, status, summary, created_at, updated_at)
       VALUES (5, 1, 'Savings test', 'How much did we save?', 'open', NULL, '2026-04-22T10:03:00Z', '2026-04-22T10:03:00Z')`
    ).run()
    db.query(
      `INSERT INTO token_events (run_id, investigation_id, command, ingested, emitted, ts) VALUES
         (1, 5, 'show', 8000, 1200, 1),
         (1, 5, 'related', 5000, 800, 2)`
    ).run()

    const capture = captureLogs()
    try {
      const ctx: CliContext = { args: ['show', '5'], repoRoot, dbPath, json: false, flags: {} }
      await runInvestigate(ctx)
    } finally {
      capture.restore()
    }

    expect(capture.lines.some(line => line.includes('Token Savings'))).toBe(true)
    // ingested 13000 - emitted 2000 = 11000 saved across 2 commands
    expect(capture.lines.some(line => line.includes('11,000') && line.includes('2 commands'))).toBe(true)
  })

  test('show --json includes a savings object', async () => {
    const repoRoot = makeTempRepo('code-spider-investigate-savings-json')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = seedRun(dbPath, repoRoot)
    db.query(
      `INSERT INTO investigations (id, run_id, title, question, status, summary, created_at, updated_at)
       VALUES (6, 1, 'Savings json', 'json?', 'open', NULL, '2026-04-22T10:03:00Z', '2026-04-22T10:03:00Z')`
    ).run()
    db.query(
      `INSERT INTO token_events (run_id, investigation_id, command, ingested, emitted, ts)
       VALUES (1, 6, 'show', 4000, 500, 1)`
    ).run()

    const capture = captureLogs()
    try {
      const ctx: CliContext = { args: ['show', '6'], repoRoot, dbPath, json: true, flags: {} }
      await runInvestigate(ctx)
    } finally {
      capture.restore()
    }

    const out = JSON.parse(capture.lines.join('\n'))
    expect(out.savings).toBeDefined()
    expect(out.savings.saved).toBe(3500)
    expect(out.savings.commandCount).toBe(1)
  })
})
