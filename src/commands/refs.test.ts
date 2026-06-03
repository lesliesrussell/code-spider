import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { AnalyzerRunner } from '../services/analyzer-runner'
import runRefs from './refs'

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
})
