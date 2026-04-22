import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import runAtoms from './atoms'

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

describe('atoms command', () => {
  test('annotates low-signal atoms in text output', async () => {
    const repoRoot = makeTempRepo('code-spider-atoms-command')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T12:00:00Z', '2026-04-22T12:01:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/example.ts', 'example.ts', 'src/example.ts', 'TypeScript', 0, 1)`
    ).run()
    db.query(
      `INSERT INTO symbols (
         id, run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json
       ) VALUES
         (1, 1, 1, 'src/example.ts:Exporter', 'Exporter', 'Class', null, null, ?, ?, null),
         (2, 1, 1, 'src/example.ts:map-callback', 'map() callback', 'Function', 'Exporter', null, ?, ?, ?)`
    ).run(
      JSON.stringify({ start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }),
      JSON.stringify({ start: { line: 0, character: 13 }, end: { line: 0, character: 21 } }),
      JSON.stringify({ start: { line: 4, character: 0 }, end: { line: 4, character: 20 } }),
      JSON.stringify({ start: { line: 4, character: 0 }, end: { line: 4, character: 14 } }),
      JSON.stringify({ signal: 'low' }),
    )

    const capture = captureLogs()
    try {
      const ctx: CliContext = {
        repoRoot,
        dbPath,
        json: false,
        args: ['unit:src/example.ts'],
        flags: {},
      }
      await runAtoms(ctx)
    } finally {
      capture.restore()
    }

    expect(capture.lines.some(line => line.includes('Exporter') && !line.includes('[low-signal]'))).toBe(true)
    expect(capture.lines.some(line => line.includes('map() callback') && line.includes('[low-signal]'))).toBe(true)
  })
})
