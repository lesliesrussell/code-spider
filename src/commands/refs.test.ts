import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { AnalyzerRunner } from '../services/analyzer-runner'
import runRefs from './refs'
// code-spider-5jl
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function seedRefsDb(repoRoot: string): string {
  const dbPath = join(repoRoot, '.code-spider', 'index.db')
  mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
  writeFileSync(join(repoRoot, 'src.ts'), 'export class ExampleService {}\n')

  const db = openDb(dbPath)
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
  ).run('2026-04-22T12:00:00Z', '2026-04-22T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (1, 1, 'unit', 'unit:src.ts', 'src.ts', 'src.ts', 'TypeScript', 0, 1)`
  ).run()
  db.query(
    `INSERT INTO symbols (
       id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    1,
    1,
    1,
    'src.ts:ExampleService',
    'ExampleService',
    'Class',
    null,
    null,
    JSON.stringify({ start: { line: 0, character: 0 }, end: { line: 0, character: 29 } }),
    JSON.stringify({ start: { line: 0, character: 13 }, end: { line: 0, character: 27 } }),
    null,
  )

  return dbPath
}

// code-spider-bl7: a caller symbol in another file plus a symbol_edges row
// (caller references ExampleService), as populateSymbolEdges writes them.
function seedEdgeReference(dbPath: string): void {
  const db = openDb(dbPath)
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (2, 1, 'unit', 'unit:caller.ts', 'caller.ts', 'caller.ts', 'TypeScript', 0, 1)`
  ).run()
  db.query(
    `INSERT INTO symbols (id, run_id, node_id, symbol_key, name, kind, range_json, selection_range_json)
     VALUES (2, 1, 2, 'caller.ts:useExample', 'useExample', 'Function', ?, ?)`
  ).run(
    JSON.stringify({ start: { line: 3, character: 0 }, end: { line: 8, character: 1 } }),
    JSON.stringify({ start: { line: 3, character: 9 }, end: { line: 3, character: 19 } }),
  )
  db.query(
    `INSERT INTO symbol_edges (run_id, from_symbol_id, to_symbol_id, kind, metadata_json)
     VALUES (1, 2, 1, 'references', '{}')`
  ).run()
}

describe('refs command', () => {
  test('marks indexed fallback as degraded in json output', async () => {
    const repoRoot = makeTempRepo('code-spider-refs-json')
    const dbPath = seedRefsDb(repoRoot)
    const capture = captureLogs()
    const originalExecuteReferences = AnalyzerRunner.prototype.executeReferences

    AnalyzerRunner.prototype.executeReferences = async () => ({
      analyzerId: 1,
      locations: [],
      error: 'no-references: src.ts',
    })

    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: true,
        args: ['ExampleService'],
        flags: {},
      }

      await runRefs(ctx)

      const payload = JSON.parse(capture.lines.join('\n')) as {
        mode: string
        degraded: boolean
        degradationReason?: string
        // code-spider-w8a
        references: Array<Record<string, unknown>>
      }

      expect(payload.mode).toBe('indexed-symbols')
      expect(payload.degraded).toBe(true)
      expect(payload.degradationReason).toContain('Fell back to indexed symbol matches')
      expect(payload.references).toEqual([{ path: 'src.ts', line: 0, column: 0, endLine: 0, endColumn: 29 }])
    } finally {
      AnalyzerRunner.prototype.executeReferences = originalExecuteReferences
      capture.restore()
    }
  })

  test('prints fallback label in text output when refs degrade', async () => {
    const repoRoot = makeTempRepo('code-spider-refs-text')
    const dbPath = seedRefsDb(repoRoot)
    const capture = captureLogs()
    const originalExecuteReferences = AnalyzerRunner.prototype.executeReferences

    AnalyzerRunner.prototype.executeReferences = async () => ({
      analyzerId: 1,
      locations: [],
      error: 'no-references: src.ts',
    })

    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: false,
        args: ['ExampleService'],
        flags: {},
      }

      await runRefs(ctx)

      expect(capture.lines[0]).toBe('Fallback references for ExampleService')
      expect(capture.lines[1]).toContain('Fell back to indexed symbol matches')
      expect(capture.lines.some(line => line.includes('src.ts:1:1'))).toBe(true)
    } finally {
      AnalyzerRunner.prototype.executeReferences = originalExecuteReferences
      capture.restore()
    }
  })

  // code-spider-bl7
  test('--indexed-only returns symbol-edge references without LSP', async () => {
    const repoRoot = makeTempRepo('code-spider-refs-indexed-only')
    const dbPath = seedRefsDb(repoRoot)
    seedEdgeReference(dbPath)
    const capture = captureLogs()
    const originalExecuteReferences = AnalyzerRunner.prototype.executeReferences
    let lspCalled = false
    AnalyzerRunner.prototype.executeReferences = async () => {
      lspCalled = true
      return { analyzerId: 1, locations: [] }
    }

    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: true,
        args: ['ExampleService'],
        flags: { 'indexed-only': true },
      }
      await runRefs(ctx)
      const payload = JSON.parse(capture.lines.join('\n'))
      expect(lspCalled).toBe(false)
      expect(payload.mode).toBe('indexed-edges')
      expect(payload.degraded).toBe(false)
      expect(payload.references).toEqual([{
        path: 'caller.ts',
        line: 3,
        column: 9,
        endLine: 3,
        endColumn: 19,
      }])
    } finally {
      AnalyzerRunner.prototype.executeReferences = originalExecuteReferences
      capture.restore()
    }
  })
})
