// code-spider-0ok
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { computeFingerprint, FindingsStore } from './findings'
import type { FindingInput } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDb(name: string) {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query(
    'INSERT INTO runs (id, started_at, repo_root) VALUES (1, ?, ?)'
  ).run('2026-06-04T09:00:00Z', dir)
  return db
}

function makeFinding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    ruleId: 'circular-dependency',
    category: 'cycles',
    severity: 'warning',
    confidence: 'high',
    title: 'Cycle between auth and session',
    summary: 'unit:src/auth.ts and unit:src/session.ts import each other',
    nodeKey: 'unit:src/auth.ts',
    anchor: 'unit:src/auth.ts->unit:src/session.ts',
    locations: [{ path: 'src/auth.ts', line: 3 }],
    metrics: { sccSize: 2 },
    tags: ['cycle'],
    ...overrides,
  }
}

describe('computeFingerprint', () => {
  test('is deterministic for identical inputs', () => {
    const a = computeFingerprint('unused-export', 'src/util/path.ts', 'normalizePathCase')
    const b = computeFingerprint('unused-export', 'src/util/path.ts', 'normalizePathCase')
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{16}$/)
  })

  test('changes when rule, path, or anchor changes', () => {
    const base = computeFingerprint('unused-export', 'src/util/path.ts', 'normalizePathCase')
    expect(computeFingerprint('unused-file', 'src/util/path.ts', 'normalizePathCase')).not.toBe(base)
    expect(computeFingerprint('unused-export', 'src/util/other.ts', 'normalizePathCase')).not.toBe(base)
    expect(computeFingerprint('unused-export', 'src/util/path.ts', 'somethingElse')).not.toBe(base)
  })

  test('normalizes path separators so fingerprints are os-stable', () => {
    const posix = computeFingerprint('unused-export', 'src/util/path.ts', 'x')
    const win = computeFingerprint('unused-export', 'src\\util\\path.ts', 'x')
    expect(win).toBe(posix)
  })
})

describe('FindingsStore', () => {
  test('add and list round-trips a finding with stable id from fingerprint', () => {
    const db = makeTempDb('findings-roundtrip')
    const store = new FindingsStore(db, 1)
    const saved = store.add(makeFinding())

    expect(saved.id).toBe(`fnd_r1_${saved.fingerprint}`)
    const listed = store.list()
    expect(listed).toHaveLength(1)
    const f = listed[0]!
    expect(f.ruleId).toBe('circular-dependency')
    expect(f.category).toBe('cycles')
    expect(f.severity).toBe('warning')
    expect(f.confidence).toBe('high')
    expect(f.nodeKey).toBe('unit:src/auth.ts')
    expect(f.locations).toEqual([{ path: 'src/auth.ts', line: 3 }])
    expect(f.metrics).toEqual({ sccSize: 2 })
    expect(f.tags).toEqual(['cycle'])
  })

  test('fingerprint is stable across line drift', () => {
    const db = makeTempDb('findings-line-drift')
    const store = new FindingsStore(db, 1)
    const before = store.add(makeFinding({ locations: [{ path: 'src/auth.ts', line: 3 }] }))
    const after = store.add(makeFinding({ locations: [{ path: 'src/auth.ts', line: 41 }] }))
    expect(after.fingerprint).toBe(before.fingerprint)
  })

  test('same-fingerprint findings in one run get ordinal-suffixed ids', () => {
    const db = makeTempDb('findings-collision')
    const store = new FindingsStore(db, 1)
    const first = store.add(makeFinding())
    const second = store.add(makeFinding())
    expect(first.id).toBe(`fnd_r1_${first.fingerprint}`)
    expect(second.id).toBe(`fnd_r1_${second.fingerprint}-2`)
  })

  // code-spider-cii: fingerprints are stable across runs by design, so ids
  // must carry a run discriminator or the second run's insert violates the
  // global primary key.
  test('identical findings in different runs coexist with distinct ids', () => {
    const db = makeTempDb('findings-cross-run')
    db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (2, 't2', '/repo')").run()
    const first = new FindingsStore(db, 1).add(makeFinding())
    const second = new FindingsStore(db, 2).add(makeFinding())
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.id).not.toBe(first.id)
    expect(new FindingsStore(db, 2).list()).toHaveLength(1)
  })

  test('list filters by category', () => {
    const db = makeTempDb('findings-filter')
    const store = new FindingsStore(db, 1)
    store.add(makeFinding())
    store.add(makeFinding({ ruleId: 'unused-file', category: 'reachability', anchor: 'src/dead.ts' }))
    const cycles = store.list({ category: 'cycles' })
    expect(cycles).toHaveLength(1)
    expect(cycles[0]!.category).toBe('cycles')
  })
})

// code-spider-l0m
describe('finding evidence', () => {
  test('addEvidence and getEvidence round-trip', () => {
    const db = makeTempDb('findings-evidence')
    const store = new FindingsStore(db, 1)
    const finding = store.add(makeFinding())
    store.addEvidence(finding.id, {
      kind: 'graph',
      source: 'imports',
      locator: 'src/auth.ts -> src/session.ts',
    })
    store.addEvidence(finding.id, {
      kind: 'graph',
      source: 'imports',
      locator: 'src/session.ts -> src/auth.ts',
    })
    const evidence = store.getEvidence(finding.id)
    expect(evidence).toHaveLength(2)
    expect(evidence[0]!.kind).toBe('graph')
    expect(evidence.map(e => e.locator)).toContain('src/auth.ts -> src/session.ts')
  })

  test('getEvidence for unknown finding returns empty', () => {
    const db = makeTempDb('findings-evidence-none')
    expect(new FindingsStore(db, 1).getEvidence('fnd_nope')).toEqual([])
  })
})
