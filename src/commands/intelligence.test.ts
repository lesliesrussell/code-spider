// code-spider-0ok
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { FindingsStore } from '../services/findings'
import runIntelligence from './intelligence'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

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

function makeIndexedRepo(name: string): { ctx: CliContext; dbPath: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(repoRoot)
  mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
  const dbPath = join(repoRoot, '.code-spider', 'index.db')
  const db = openDb(dbPath)
  db.query('INSERT INTO runs (id, started_at, completed_at, repo_root) VALUES (1, ?, ?, ?)').run(
    '2026-06-04T09:00:00Z',
    '2026-06-04T09:01:00Z',
    repoRoot
  )
  db.close()
  const ctx: CliContext = { repoRoot, dbPath, json: false, args: [], flags: {} }
  return { ctx, dbPath }
}

describe('intelligence scan', () => {
  test('emits empty findings summary as json on a clean run', async () => {
    const { ctx } = makeIndexedRepo('intel-empty')
    ctx.json = true
    ctx.args = ['scan']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      runId: number
      summary: { findings: number; byCategory: Record<string, number> }
      findings: unknown[]
    }
    expect(out.runId).toBe(1)
    expect(out.summary.findings).toBe(0)
    expect(out.findings).toEqual([])
  })

  test('lists seeded findings in json output with fingerprints', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-seeded')
    const db = openDb(dbPath)
    const store = new FindingsStore(db, 1)
    store.add({
      ruleId: 'circular-dependency',
      category: 'cycles',
      severity: 'warning',
      confidence: 'high',
      title: 'Cycle between a and b',
      summary: 'a.ts and b.ts import each other',
      anchor: 'unit:a.ts<->unit:b.ts',
      nodeKey: 'unit:a.ts',
      locations: [{ path: 'a.ts', line: 1 }],
    })
    db.close()

    ctx.json = true
    ctx.args = ['scan']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      summary: { findings: number; byCategory: Record<string, number> }
      findings: Array<{ ruleId: string; fingerprint: string }>
    }
    expect(out.summary.findings).toBe(1)
    expect(out.summary.byCategory['cycles']).toBe(1)
    expect(out.findings[0]!.ruleId).toBe('circular-dependency')
    expect(out.findings[0]!.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  test('renders human-readable table with severity and location', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-table')
    const db = openDb(dbPath)
    new FindingsStore(db, 1).add({
      ruleId: 'circular-dependency',
      category: 'cycles',
      severity: 'warning',
      confidence: 'high',
      title: 'Cycle between a and b',
      summary: 'a.ts and b.ts import each other',
      anchor: 'unit:a.ts<->unit:b.ts',
      locations: [{ path: 'a.ts', line: 1 }],
    })
    db.close()

    ctx.args = ['scan']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const text = logs.lines.join('\n')
    expect(text).toContain('circular-dependency')
    expect(text).toContain('warning')
    expect(text).toContain('a.ts:1')
  })

  test('scan --category filters findings', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-filter')
    const db = openDb(dbPath)
    const store = new FindingsStore(db, 1)
    store.add({
      ruleId: 'circular-dependency',
      category: 'cycles',
      severity: 'warning',
      confidence: 'high',
      title: 'Cycle',
      summary: 'cycle',
      anchor: 'a<->b',
      locations: [{ path: 'a.ts' }],
    })
    store.add({
      ruleId: 'unused-file',
      category: 'reachability',
      severity: 'warning',
      confidence: 'medium',
      title: 'Unused file',
      summary: 'dead',
      anchor: 'dead.ts',
      locations: [{ path: 'dead.ts' }],
    })
    db.close()

    ctx.json = true
    ctx.args = ['scan']
    ctx.flags = { category: 'reachability' }
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as { findings: Array<{ ruleId: string }> }
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.ruleId).toBe('unused-file')
  })
})
