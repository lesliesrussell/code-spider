import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { AnalyzerRunner } from '../services/analyzer-runner'
import runDefs from './defs'
// code-spider-5jl
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function seedDefsDb(repoRoot: string): string {
  const dbPath = join(repoRoot, '.code-spider', 'index.db')
  mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
  mkdirSync(join(repoRoot, 'src'), { recursive: true })
  writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export class ExampleService {}\nnew ExampleService()\n')

  const db = openDb(dbPath)
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
  ).run('2026-04-22T12:00:00Z', '2026-04-22T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (1, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', 0, 1)`
  ).run()
  db.query(
    `INSERT INTO symbols (
       id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    1,
    1,
    1,
    'src/index.ts:ExampleService',
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

describe('defs command', () => {
  test('marks indexed fallback as degraded in json output when semantic definitions fail', async () => {
    const repoRoot = makeTempRepo('code-spider-defs-json')
    const dbPath = seedDefsDb(repoRoot)
    const capture = captureLogs()
    const originalExecuteDefinitions = AnalyzerRunner.prototype.executeDefinitions

    AnalyzerRunner.prototype.executeDefinitions = async () => ({
      analyzerId: 1,
      locations: [],
      error: 'no-definitions: src/index.ts',
    })

    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: true,
        args: ['ExampleService'],
        flags: {},
      }

      await runDefs(ctx)

      const payload = JSON.parse(capture.lines.join('\n')) as {
        mode: string
        degraded: boolean
        degradationReason?: string
        // code-spider-w8a
        matches: Array<Record<string, unknown>>
      }

      expect(payload.mode).toBe('indexed-symbols')
      expect(payload.degraded).toBe(true)
      expect(payload.degradationReason).toContain('Fell back to indexed symbol definitions')
      expect(payload.matches).toEqual([{
        path: 'src/index.ts',
        line: 0,
        column: 0,
        endLine: 0,
        endColumn: 29,
        kind: 'Class',
        containerName: null,
        heuristic: false,
      }])
    } finally {
      AnalyzerRunner.prototype.executeDefinitions = originalExecuteDefinitions
      capture.restore()
    }
  })

  // code-spider-bl7
  test('--indexed-only skips LSP and returns indexed matches undegraded', async () => {
    const repoRoot = makeTempRepo('code-spider-defs-indexed-only')
    const dbPath = seedDefsDb(repoRoot)
    const capture = captureLogs()
    const originalExecuteDefinitions = AnalyzerRunner.prototype.executeDefinitions
    let lspCalled = false
    AnalyzerRunner.prototype.executeDefinitions = async () => {
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
      await runDefs(ctx)
      const payload = JSON.parse(capture.lines.join('\n'))
      expect(lspCalled).toBe(false)
      expect(payload.mode).toBe('indexed-symbols')
      expect(payload.degraded).toBe(false)
      expect(payload.matches.length).toBe(1)
      expect(payload.matches[0].path).toBe('src/index.ts')
    } finally {
      AnalyzerRunner.prototype.executeDefinitions = originalExecuteDefinitions
      capture.restore()
    }
  })

  test('uses semantic definitions when available', async () => {
    const repoRoot = makeTempRepo('code-spider-defs-text')
    const dbPath = seedDefsDb(repoRoot)
    const capture = captureLogs()
    const originalExecuteDefinitions = AnalyzerRunner.prototype.executeDefinitions

    AnalyzerRunner.prototype.executeDefinitions = async () => ({
      analyzerId: 1,
      locations: [{
        uri: `file://${join(repoRoot, 'src', 'index.ts')}`,
        path: join(repoRoot, 'src', 'index.ts'),
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 27 },
        },
      }],
    })

    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: false,
        args: ['ExampleService'],
        flags: {},
      }

      await runDefs(ctx)

      expect(capture.lines[0]).toBe('Definitions for ExampleService')
      expect(capture.lines.some(line => line.includes('src/index.ts:1:14'))).toBe(true)
    } finally {
      AnalyzerRunner.prototype.executeDefinitions = originalExecuteDefinitions
      capture.restore()
    }
  })
})

