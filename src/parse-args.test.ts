// code-spider-7ui
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// code-spider-1iv
import { parseArgs } from './parse-args'

describe('parseArgs', () => {
  test('basic command', () => {
    const result = parseArgs(['doctor'])
    expect(result.args).toEqual(['doctor'])
    expect(result.json).toBe(false)
  })

  test('--json flag', () => {
    const result = parseArgs(['overview', '--json'])
    expect(result.json).toBe(true)
    expect(result.flags.json).toBe(true)
  })

  test('--repo flag', () => {
    const result = parseArgs(['inspect', '--repo', '/tmp/test-repo'])
    expect(result.repoRoot).toBe(resolve('/tmp/test-repo'))
    expect(result.flags.repo).toBe(resolve('/tmp/test-repo'))
  })

  test('--db flag', () => {
    const result = parseArgs(['doctor', '--db', '/tmp/custom.db'])
    expect(result.flags.db).toBe(resolve('/tmp/custom.db'))
    expect(result.dbPath).toBe(resolve('/tmp/custom.db'))
  })

  test('mixed flags and positional args', () => {
    const result = parseArgs(['show', 'unit:src/foo.ts', '--json', '--limit', '5'])
    expect(result.args).toEqual(['show', 'unit:src/foo.ts'])
    expect(result.json).toBe(true)
    expect(result.flags.limit).toBe('5')
  })

  test('boolean flags', () => {
    const result = parseArgs(['zones', '--kind', 'src'])
    expect(result.flags.kind).toBe('src')
  })

  test('defaults to cwd when no --repo', () => {
    const result = parseArgs(['overview'])
    expect(result.repoRoot).toBe(process.cwd())
  })
})
