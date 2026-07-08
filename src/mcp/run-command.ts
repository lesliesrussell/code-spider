// code-spider-o7o
// Runs a CLI command module in-process for the MCP server: builds a
// CliContext, captures console output, and contains process.exit so a
// user-input error (exit 1) becomes a thrown McpCommandError instead of
// killing the server. Reuses the tested command paths rather than
// reimplementing query logic per tool.
import type { CliContext } from '../types'
import { resolve } from 'node:path'

export class McpCommandError extends Error {}

// Sentinel thrown by the patched process.exit; never escapes runCommand.
class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

export interface CommandInvocation {
  command: string
  args?: string[]
  flags?: Record<string, string | boolean>
  repoRoot: string
  dbPath?: string
  json?: boolean
}

type CommandModule = { default: (ctx: CliContext) => Promise<void> }

const COMMANDS: Record<string, () => Promise<CommandModule>> = {
  overview: () => import('../commands/overview'),
  zones: () => import('../commands/zones'),
  show: () => import('../commands/show'),
  children: () => import('../commands/children'),
  related: () => import('../commands/related'),
  flows: () => import('../commands/flows'),
  find: () => import('../commands/find'),
  refs: () => import('../commands/refs'),
  defs: () => import('../commands/defs'),
  atoms: () => import('../commands/atoms'),
  intelligence: () => import('../commands/intelligence'),
  doctor: () => import('../commands/doctor'),
}

export const MCP_COMMANDS = Object.keys(COMMANDS)

export async function runCommand(invocation: CommandInvocation): Promise<string> {
  const loader = COMMANDS[invocation.command]
  if (loader === undefined) {
    throw new McpCommandError(`Unknown command: ${invocation.command}`)
  }
  const mod = await loader()

  const repoRoot = resolve(invocation.repoRoot)
  const json = invocation.json ?? true
  const ctx: CliContext = {
    repoRoot,
    dbPath: invocation.dbPath !== undefined
      ? resolve(invocation.dbPath)
      : resolve(repoRoot, '.code-spider', 'index.db'),
    json,
    args: invocation.args ?? [],
    flags: { ...(invocation.flags ?? {}), ...(json ? { json: true } : {}) },
  }

  const out: string[] = []
  const errOut: string[] = []
  const originalLog = console.log
  const originalError = console.error
  const originalExit = process.exit
  console.log = (...args: unknown[]) => {
    out.push(args.map(arg => String(arg)).join(' '))
  }
  console.error = (...args: unknown[]) => {
    errOut.push(args.map(arg => String(arg)).join(' '))
  }
  // eslint-disable-next-line no-restricted-syntax
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0)
  }) as typeof process.exit

  try {
    await mod.default(ctx)
    return out.join('\n')
  } catch (err) {
    if (err instanceof ExitSignal) {
      if (err.code === 0) return out.join('\n')
      throw new McpCommandError(errOut.join('\n') || `command exited with code ${err.code}`)
    }
    throw err
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exit = originalExit
  }
}
