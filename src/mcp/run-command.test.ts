// code-spider-o7o
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../db/init'
import { McpCommandError, runCommand } from './run-command'
import { cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function seedIndexedRepo(name: string): string {
  const repoRoot = makeTempRepo(name)
  mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
  const db = openDb(join(repoRoot, '.code-spider', 'index.db'))
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
  ).run('2026-07-08T12:00:00Z', '2026-07-08T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (1, 1, 'repo', 'repo:.', 'test-repo', '.', null, 0, 1),
            (2, 1, 'unit', 'unit:src/a.ts', 'a.ts', 'src/a.ts', 'TypeScript', 0, 1)`
  ).run()
  db.close()
  return repoRoot
}

describe('runCommand', () => {
  test('captures json output from a command module', async () => {
    const repoRoot = seedIndexedRepo('code-spider-mcp-run')
    const output = await runCommand({ command: 'zones', repoRoot })
    expect(() => JSON.parse(output)).not.toThrow()
  })

  test('contains process.exit(1) as McpCommandError with the stderr message', async () => {
    const repoRoot = makeTempRepo('code-spider-mcp-noindex')
    expect(runCommand({ command: 'zones', repoRoot })).rejects.toThrow(McpCommandError)
    await runCommand({ command: 'zones', repoRoot }).catch((err: Error) => {
      expect(err.message).toContain('No index found')
    })
    // the patch must not leak
    expect(typeof process.exit).toBe('function')
    expect(String(process.exit)).not.toContain('ExitSignal')
  })

  test('rejects unknown commands', async () => {
    expect(runCommand({ command: 'rm-rf', repoRoot: '/tmp' })).rejects.toThrow('Unknown command')
  })

  test('restores console.log after the command finishes', async () => {
    const repoRoot = seedIndexedRepo('code-spider-mcp-restore')
    const original = console.log
    await runCommand({ command: 'zones', repoRoot })
    expect(console.log).toBe(original)
  })
})
