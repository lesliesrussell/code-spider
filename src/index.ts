#!/usr/bin/env bun

import { resolve } from 'node:path'
import type { CliContext } from './types'

const USAGE = `code-spider <command> [options]

Commands:
  doctor [semantic|repo|perf]          Check environment and analysis readiness
  inspect [path]                       Inspect a repository without writing inside it
  index [path]                         Index a repository
  overview                             Repository overview
  zones [--kind <kind>]                List top-level zones
  show <node-ref>                      Show node details
  children <node-ref>                  List child nodes
  related <node-ref>                   List related nodes
  flows [<node-ref>]                   List flows
  refs <symbol>                        Find references
  defs <symbol>                        Find definitions
  atoms <unit-ref>                     List atoms in a unit
  investigate <start|add|note|show>    Manage investigations
  export report <ref>                  Export a report

Options:
  --repo <path>    Target repository (default: cwd)
  --db <path>      Override database path
  --json           Machine-readable JSON output`

function parseArgs(argv: string[]): CliContext {
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

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    process.exit(0)
  }
  const ctx = parseArgs(argv)
  const command = ctx.args[0]
  // Remove command from positional args
  ctx.args = ctx.args.slice(1)

  switch (command) {
    case 'doctor': {
      const mod = await import('./commands/doctor')
      await mod.default(ctx)
      break
    }
    case 'index': {
      const mod = await import('./commands/index-cmd')
      await mod.default(ctx)
      break
    }
    case 'inspect': {
      const mod = await import('./commands/inspect')
      await mod.default(ctx)
      break
    }
    case 'overview': {
      const mod = await import('./commands/overview')
      await mod.default(ctx)
      break
    }
    case 'zones': {
      const mod = await import('./commands/zones')
      await mod.default(ctx)
      break
    }
    case 'show': {
      const mod = await import('./commands/show')
      await mod.default(ctx)
      break
    }
    case 'children': {
      const mod = await import('./commands/children')
      await mod.default(ctx)
      break
    }
    case 'related': {
      const mod = await import('./commands/related')
      await mod.default(ctx)
      break
    }
    case 'flows': {
      const mod = await import('./commands/flows')
      await mod.default(ctx)
      break
    }
    case 'refs': {
      const mod = await import('./commands/refs')
      await mod.default(ctx)
      break
    }
    case 'defs': {
      const mod = await import('./commands/defs')
      await mod.default(ctx)
      break
    }
    case 'atoms': {
      const mod = await import('./commands/atoms')
      await mod.default(ctx)
      break
    }
    case 'investigate': {
      const mod = await import('./commands/investigate')
      await mod.default(ctx)
      break
    }
    case 'export': {
      const mod = await import('./commands/export-cmd')
      await mod.default(ctx)
      break
    }
    default: {
      console.log(USAGE)
      process.exit(1)
    }
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
