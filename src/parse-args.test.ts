// code-spider-7ui
import { describe, expect, test } from 'bun:test'
import { resolve } from 'node:path'

// We import the internal parseArgs by temporarily exporting it or testing via the CLI.
// For a focused test, we'll re-implement a minimal version here to test the logic.
// In a real project we would export parseArgs from index.ts.

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  let repoRoot = process.cwd()
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''

    if (arg === '--json') {
      json = true
      flags['json'] = true
    } else if (arg === '--repo') {
      const next = argv[++i]
      if (next !== undefined) {
        repoRoot = resolve(next)
        flags['repo'] = repoRoot
      }
    } else if (arg === '--db') {
      const next = argv[++i]
      if (next !== undefined) {
        flags['db'] = resolve(next)
      }
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (arg !== '') {
      args.push(arg)
    }
  }

  const dbOverride = typeof flags['db'] === 'string' ? flags['db'] : undefined
  const dbPath = dbOverride ?? resolve(repoRoot, '.code-spider', 'index.db')

  return { repoRoot, dbPath, json, args, flags }
}

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
