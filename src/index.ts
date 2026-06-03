#!/usr/bin/env bun

import { resolve } from 'node:path'
import type { CliContext } from './types'

// code-spider-vo4
// USAGE documents exactly the flags each command parses today — nothing
// aspirational. PRD-planned flags (e.g. index --incremental) stay out until
// they exist.
const USAGE = `code-spider <command> [options]

Commands:
  doctor [semantic|repo|perf]          Check environment and analysis readiness
  inspect [path]                       Inspect a repository without writing inside it
  index [path] [--semantic] [--max-files <n|all>]
                                       Index a repository; --semantic adds symbol enrichment
                                       (default cap 100 files; --max-files all lifts it)
  overview                             Repository overview
  zones [--limit <n>]                  List top-level zones
  show <node-ref> [--semantic] [--evidence]
                                       Show node details; --semantic adds atoms,
                                       --evidence lifts the 5-row evidence cap
  children <node-ref> [--limit <n>] [--sort score|churn|loc|recent]
                                       List child nodes
  related <node-ref> [--kind topology|symbols|docs|git|issues|flows] [--limit <n>]
                                       List related nodes, optionally by one signal
  flows [<node-ref>] [--limit <n>]     List detected flows
  refs <symbol>                        Find references
  defs <symbol>                        Find definitions
  atoms <unit-ref>                     List atoms in a unit
  investigate                          List investigations
  investigate start "<question>"       Start an investigation
  investigate add <inv-id> <node-ref>  Add a node to an investigation
  investigate note <inv-id> <text>     Add a note to an investigation
  investigate show <inv-id>            Show an investigation
  export report <node-ref|inv-id> [--format md|json]
                                       Export a report

Options (all commands):
  --repo <path>    Target repository (default: cwd)
  --db <path>      Override database path (default: <repo>/.code-spider/index.db)
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
