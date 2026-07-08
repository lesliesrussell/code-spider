// code-spider-tnf
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CliContext } from '../types'
import runMcp from './mcp'
import { captureLogs, cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

function ctxFor(repoRoot: string, args: string[]): CliContext {
  return {
    repoRoot,
    dbPath: join(repoRoot, '.code-spider', 'index.db'),
    json: false,
    args,
    flags: {},
  }
}

describe('mcp install', () => {
  test('creates .mcp.json with the code-spider server entry', async () => {
    const repoRoot = makeTempRepo('code-spider-mcp-install-new')
    const capture = captureLogs()
    try {
      await runMcp(ctxFor(repoRoot, ['install']))
    } finally {
      capture.restore()
    }

    const configPath = join(repoRoot, '.mcp.json')
    expect(existsSync(configPath)).toBe(true)
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.mcpServers['code-spider']).toEqual({
      command: 'code-spider',
      args: ['mcp'],
    })
    expect(capture.lines.some(line => line.includes('.mcp.json'))).toBe(true)
  })

  test('merges into an existing .mcp.json without touching other servers', async () => {
    const repoRoot = makeTempRepo('code-spider-mcp-install-merge')
    const configPath = join(repoRoot, '.mcp.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: { other: { command: 'other-server', args: ['--x'] } },
    }, null, 2))

    const capture = captureLogs()
    try {
      await runMcp(ctxFor(repoRoot, ['install']))
    } finally {
      capture.restore()
    }

    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    expect(config.mcpServers.other).toEqual({ command: 'other-server', args: ['--x'] })
    expect(config.mcpServers['code-spider']).toEqual({ command: 'code-spider', args: ['mcp'] })
  })

  test('is idempotent', async () => {
    const repoRoot = makeTempRepo('code-spider-mcp-install-idem')
    const capture = captureLogs()
    try {
      await runMcp(ctxFor(repoRoot, ['install']))
      await runMcp(ctxFor(repoRoot, ['install']))
    } finally {
      capture.restore()
    }

    const config = JSON.parse(readFileSync(join(repoRoot, '.mcp.json'), 'utf8'))
    expect(Object.keys(config.mcpServers)).toEqual(['code-spider'])
  })

  test('refuses to clobber a malformed .mcp.json', async () => {
    const repoRoot = makeTempRepo('code-spider-mcp-install-bad')
    const configPath = join(repoRoot, '.mcp.json')
    writeFileSync(configPath, '{ not json')

    const errors: string[] = []
    const originalError = console.error
    const originalExit = process.exit
    let exitCode: number | undefined
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    process.exit = ((code?: number) => { exitCode = code ?? 0; throw new Error('exit') }) as typeof process.exit
    try {
      await runMcp(ctxFor(repoRoot, ['install'])).catch(() => {})
    } finally {
      console.error = originalError
      process.exit = originalExit
    }

    expect(exitCode).toBe(1)
    expect(errors.some(line => line.includes('.mcp.json'))).toBe(true)
    expect(readFileSync(configPath, 'utf8')).toBe('{ not json')
  })
})
