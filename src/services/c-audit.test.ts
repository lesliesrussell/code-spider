// code-spider-zox
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { FindingsStore } from './findings'
import { CAuditAnalyzer } from './c-audit'

const tempDirs: string[] = []
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface SeedDiag {
  tool: string
  severity: string
  code: string | null
  message: string
  line0: number // LSP 0-based start line
  col0: number
}

function seedDiagnostics(diags: SeedDiag[]) {
  const dir = mkdtempSync(join(tmpdir(), 'c-audit-db-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path) VALUES (1, 1, 'unit', 'unit:src/foo.c', 'foo.c', 'src/foo.c')`
  ).run()

  const analyzerId = new Map<string, number>()
  const insertAnalyzer = db.prepare(
    `INSERT INTO analyzers (run_id, language, tool_name, tool_kind, available) VALUES (1, 'c', ?, 'quality', 1)`
  )
  const insertDiag = db.prepare(
    `INSERT INTO diagnostics (run_id, node_id, analyzer_id, severity, code, message, range_json) VALUES (1, 1, ?, ?, ?, ?, ?)`
  )
  for (const d of diags) {
    if (!analyzerId.has(d.tool)) {
      insertAnalyzer.run(d.tool)
      analyzerId.set(d.tool, Number((db.query('SELECT last_insert_rowid() AS id').get() as { id: number }).id))
    }
    const range = JSON.stringify({
      start: { line: d.line0, character: d.col0 },
      end: { line: d.line0, character: d.col0 },
    })
    insertDiag.run(analyzerId.get(d.tool)!, d.severity, d.code, d.message, range)
  }
  return db
}

describe('CAuditAnalyzer', () => {
  test('promotes clang-tidy/cppcheck error+warning diagnostics into correctness findings', () => {
    const db = seedDiagnostics([
      { tool: 'clang-tidy', severity: 'error', code: 'clang-analyzer-core.NullDereference', message: 'Null deref', line0: 9, col0: 6 },
      { tool: 'clang-tidy', severity: 'warning', code: 'bugprone-foo', message: 'Maybe bug', line0: 19, col0: 0 },
      { tool: 'clang-tidy', severity: 'info', code: 'readability-x', message: 'style nit', line0: 4, col0: 0 },
      { tool: 'cppcheck', severity: 'error', code: 'nullPointer', message: 'Null pointer', line0: 2, col0: 1 },
      { tool: 'typescript-language-server', severity: 'error', code: 'TS2304', message: 'not c/c++', line0: 0, col0: 0 },
    ])

    new CAuditAnalyzer().analyze(db, 1)
    const findings = new FindingsStore(db, 1).list({ category: 'correctness' })

    // error + warning from clang-tidy, error from cppcheck; info skipped; ts excluded.
    expect(findings).toHaveLength(3)

    const nullDeref = findings.find(f => f.ruleId === 'clang-analyzer-core.NullDereference')
    expect(nullDeref?.severity).toBe('error')
    expect(nullDeref?.confidence).toBe('high')
    expect(nullDeref?.locations[0]).toEqual({ path: 'src/foo.c', line: 10, column: 7 })
    expect(nullDeref?.nodeKey).toBe('unit:src/foo.c')

    const warn = findings.find(f => f.ruleId === 'bugprone-foo')
    expect(warn?.severity).toBe('warning')
    expect(warn?.confidence).toBe('medium')

    expect(findings.some(f => f.ruleId === 'nullPointer')).toBe(true)
    expect(findings.some(f => f.ruleId === 'TS2304')).toBe(false)
    expect(findings.some(f => f.ruleId === 'readability-x')).toBe(false)
  })

  test('links the originating diagnostic as evidence', () => {
    const db = seedDiagnostics([
      { tool: 'clang-tidy', severity: 'error', code: 'check-x', message: 'boom', line0: 0, col0: 0 },
    ])
    new CAuditAnalyzer().analyze(db, 1)
    const store = new FindingsStore(db, 1)
    const finding = store.list({ category: 'correctness' })[0]!
    const evidence = store.getEvidence(finding.id)
    expect(evidence).toHaveLength(1)
    expect(evidence[0]?.source).toBe('clang-tidy')
    expect(evidence[0]?.snippet).toBe('boom')
  })

  test('is idempotent — re-running does not duplicate findings', () => {
    const db = seedDiagnostics([
      { tool: 'clang-tidy', severity: 'error', code: 'check-x', message: 'boom', line0: 0, col0: 0 },
    ])
    new CAuditAnalyzer().analyze(db, 1)
    new CAuditAnalyzer().analyze(db, 1)
    expect(new FindingsStore(db, 1).list({ category: 'correctness' })).toHaveLength(1)
  })
})
