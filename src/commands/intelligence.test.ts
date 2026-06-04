// code-spider-0ok
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import runIntelligence, { runAnalyzers } from './intelligence'

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

// code-spider-q6b
function seedImportCycle(dbPath: string): void {
  const db = openDb(dbPath)
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path) VALUES
       (10, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts'),
       (11, 1, 'unit', 'unit:src/b.ts', 'b.ts', 'src/b.ts')`
  ).run()
  db.query(
    `INSERT INTO edges (run_id, from_node_id, to_node_id, kind) VALUES (1, 10, 11, 'imports'), (1, 11, 10, 'imports')`
  ).run()
  db.close()
}

describe('intelligence cycles', () => {
  test('detects and lists cycle findings from import edges', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-cycles')
    seedImportCycle(dbPath)
    ctx.json = true
    ctx.args = ['cycles']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      findings: Array<{ ruleId: string; locations: Array<{ path: string }> }>
    }
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.ruleId).toBe('circular-dependency')
    expect(out.findings[0]!.locations.map(l => l.path)).toEqual(['src/a.ts', 'src/b.ts'])
  })

  test('scan refreshes cycle findings before listing', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-scan-refresh')
    seedImportCycle(dbPath)
    ctx.json = true
    ctx.args = ['scan']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as { summary: { byCategory: Record<string, number> } }
    expect(out.summary.byCategory['cycles']).toBe(1)
  })
})

// code-spider-cii
describe('intelligence unused', () => {
  test('flags units unreachable from entrypoints', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-unused')
    const db = openDb(dbPath)
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, metadata_json) VALUES
         (20, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', '{"entrypoint":true}'),
         (21, 1, 'unit', 'unit:src/dead.ts', 'dead.ts', 'src/dead.ts', 'TypeScript', NULL)`
    ).run()
    db.close()

    ctx.json = true
    ctx.args = ['unused']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      findings: Array<{ ruleId: string; locations: Array<{ path: string }>; confidence: string }>
    }
    expect(out.findings).toHaveLength(1)
    expect(out.findings[0]!.ruleId).toBe('unused-file')
    expect(out.findings[0]!.locations[0]!.path).toBe('src/dead.ts')
    expect(out.findings[0]!.confidence).toBe('high')
  })

  test('warns when no entrypoints are configured', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-unused-noroots')
    const db = openDb(dbPath)
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language) VALUES
         (20, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript')`
    ).run()
    db.close()

    ctx.args = ['unused']
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => String(a)).join(' '))
    }
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
      console.error = originalError
    }
    expect(errors.join('\n')).toContain('entrypoint')
    expect(logs.lines.join('\n')).toContain('(no findings)')
  })
})

// code-spider-c4l
describe('suppressions in scan', () => {
  test('config-suppressed findings vanish; stale entries surface', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-suppress')
    const db = openDb(dbPath)
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, metadata_json) VALUES
         (20, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', '{"entrypoint":true}'),
         (21, 1, 'unit', 'unit:src/legacy/old.ts', 'old.ts', 'src/legacy/old.ts', 'TypeScript', NULL)`
    ).run()
    db.close()
    mkdirSync(join(ctx.repoRoot, '.code-spider'), { recursive: true })
    writeFileSync(
      join(ctx.repoRoot, '.code-spider', 'config.yaml'),
      `intelligence:
  suppressions:
    - rule: unused-file
      path: "src/legacy/**"
      expires: "2099-12-31"
    - rule: circular-dependency
      path: "src/never/**"
`
    )

    ctx.json = true
    ctx.args = ['scan']
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      findings: Array<{ ruleId: string; locations: Array<{ path: string }> }>
    }
    const rules = out.findings.map(f => f.ruleId)
    expect(rules).not.toContain('unused-file') // suppressed
    expect(rules).toContain('stale-suppression') // the never-matching entry
    const stale = out.findings.filter(f => f.ruleId === 'stale-suppression')
    expect(stale).toHaveLength(1)
    expect(stale[0]!.locations[0]!.path).toBe('src/never/**')
  })
})

// code-spider-l0m
describe('intelligence explain', () => {
  test('shows a cycle finding with its import-edge evidence in json', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-explain')
    seedImportCycle(dbPath)

    // First scan computes findings + evidence
    ctx.json = true
    ctx.args = ['cycles']
    let logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const findingId = (JSON.parse(logs.lines.join('\n')) as { findings: Array<{ id: string }> }).findings[0]!.id

    ctx.args = ['explain', findingId]
    logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const out = JSON.parse(logs.lines.join('\n')) as {
      finding: { id: string; ruleId: string }
      evidence: Array<{ kind: string; locator?: string }>
    }
    expect(out.finding.id).toBe(findingId)
    expect(out.finding.ruleId).toBe('circular-dependency')
    expect(out.evidence.map(e => e.locator).sort()).toEqual(['src/a.ts -> src/b.ts', 'src/b.ts -> src/a.ts'])
  })

  test('human output lists evidence lines', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-explain-human')
    seedImportCycle(dbPath)
    ctx.args = ['cycles']
    let logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const idLine = logs.lines.find(l => l.includes('id: fnd_'))!
    const findingId = idLine.slice(idLine.indexOf('fnd_')).trim()

    ctx.args = ['explain', findingId]
    logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const text = logs.lines.join('\n')
    expect(text).toContain('circular-dependency')
    expect(text).toContain('src/a.ts -> src/b.ts')
  })

  test('unknown finding id exits 1 with a clean message', () => {
    const { ctx } = makeIndexedRepo('intel-explain-unknown')
    const result = Bun.spawnSync({
      cmd: ['bun', 'run', 'src/index.ts', 'intelligence', 'explain', 'fnd_nope', '--repo', ctx.repoRoot, '--db', ctx.dbPath],
      cwd: process.cwd(),
    })
    expect(result.exitCode).toBe(1)
    expect(result.stderr.toString()).toContain('fnd_nope')
  })
})

// code-spider-773
describe('scan --format md', () => {
  test('renders a grouped markdown report with evidence', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-md')
    seedImportCycle(dbPath)
    ctx.args = ['scan']
    ctx.flags = { format: 'md' }
    const logs = captureLogs()
    try {
      await runIntelligence(ctx)
    } finally {
      logs.restore()
    }
    const md = logs.lines.join('\n')
    expect(md).toContain('# Intelligence findings (run #1)')
    expect(md).toContain('## cycles')
    expect(md).toContain('circular-dependency')
    expect(md).toContain('- graph/imports: src/a.ts -> src/b.ts')
  })
})

describe('analyzer fail-soft', () => {
  test('a crashing analyzer warns and later analyzers still run', async () => {
    const { dbPath } = makeIndexedRepo('intel-failsoft')
    const db = openDb(dbPath)
    const ran: string[] = []
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args.map(a => String(a)).join(' '))
    }
    let threw = false
    try {
      await runAnalyzers(db, 1, '/repo', undefined, [
        {
          name: 'cycles',
          category: 'cycles',
          run: () => {
            throw new Error('synthetic crash')
          },
        },
        { name: 'after', category: 'reachability', run: () => void ran.push('after') },
      ])
    } catch {
      threw = true
    } finally {
      console.error = originalError
      db.close()
    }
    expect(threw).toBe(false)
    expect(errors.join('\n')).toContain('cycles analyzer failed: synthetic crash')
    expect(ran).toEqual(['after'])
  })
})

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

  // code-spider-q6b: scan recomputes analyzer-backed categories, so these
  // seed real import edges rather than hand-written findings rows.
  test('lists computed findings in json output with fingerprints', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-seeded')
    seedImportCycle(dbPath)

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
    seedImportCycle(dbPath)

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
    expect(text).toContain('src/a.ts')
  })

  test('scan --category filters findings', async () => {
    const { ctx, dbPath } = makeIndexedRepo('intel-filter')
    // Real graph state: an import cycle AND a dead file, so both analyzers
    // produce findings and the filter has something to exclude.
    seedImportCycle(dbPath)
    const db = openDb(dbPath)
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, metadata_json) VALUES
         (20, 1, 'unit', 'unit:src/main.ts', 'main.ts', 'src/main.ts', 'TypeScript', '{"entrypoint":true}'),
         (21, 1, 'unit', 'unit:src/dead.ts', 'dead.ts', 'src/dead.ts', 'TypeScript', NULL)`
    ).run()
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
