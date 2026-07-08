#!/usr/bin/env bun

// code-spider-1iv
import { parseArgs } from './parse-args'
// code-spider-ab9
import { existsSync } from 'node:fs'
import { openDb } from './db/init'
import { Navigator } from './services/navigator'
import { resetLedger } from './services/token-ledger'
import { recordCommandEvent } from './services/record-event'

// code-spider-vo4
// USAGE documents exactly the flags each command parses today — nothing
// aspirational. PRD-planned flags (e.g. index --incremental) stay out until
// they exist.
const USAGE = `code-spider <command> [options]

Commands:
  doctor [semantic|repo|perf]          Check environment and analysis readiness
  inspect [path]                       Inspect a repository without writing inside it
  index [path] [--semantic] [--embed] [--incremental] [--max-files <n|all>]
                                       Index a repository; --semantic adds symbol enrichment
                                       (default cap 100 files; --max-files all lifts it);
                                       --embed adds nomic-embed-text vectors (needs ollama);
                                       --incremental reuses results for unchanged files
  overview [--run <id>]                Repository overview (default: latest run)
  zones [--kind <language>] [--limit <n>]
                                       List top-level zones, optionally by dominant language
  show <node-ref> [--semantic] [--evidence]
                                       Show node details; --semantic adds atoms,
                                       --evidence lifts the 5-row evidence cap
  children <node-ref> [--limit <n>] [--sort score|churn|loc|recent]
                                       List child nodes
  related <node-ref> [--kind topology|symbols|docs|git|issues|flows|meaning] [--limit <n>]
                                       List related nodes, optionally by one signal
  flows [<node-ref>] [--limit <n>]     List detected flows
  find "<query>" [--limit <n>]         Semantic search over embedded units
  refs <symbol> [--indexed-only]       Find references (--indexed-only: no LSP, symbol-edge granularity)
  prune [--keep <n>] [--dry-run]       Delete stale runs, reclaim db space (default keep: 3)
  mcp [install]                        Run as an MCP stdio server; install writes project .mcp.json
  defs <symbol> [--indexed-only]       Find definitions (--indexed-only: no LSP)
  atoms <unit-ref>                     List atoms in a unit
  investigate                          List investigations
  investigate start "<question>"       Start an investigation
  investigate add <inv-id> <node-ref>  Add a node to an investigation
  investigate pin <inv-id> <evidence-id> [note]
                                       Pin an evidence row (ids in show output)
  investigate note <inv-id> <text>     Add a note to an investigation
  investigate show <inv-id>            Show an investigation
  investigate end                      Stop attributing commands to an investigation
  export report <node-ref|inv-id> [--format md|json]
                                       Export a report
  intelligence scan [--category <c>]   Run intelligence analyzers, list findings
                                       (reachability|cycles|duplication|hotspots|architecture)
  intelligence cycles                  Detect circular dependencies in the import graph
  intelligence unused                  Find files unreachable from configured entrypoints
  intelligence dupes                   Detect duplicated files and regions
  intelligence hotspots                Rank risk hotspots by weighted signals
  intelligence arch                    Check declared layer and boundary rules
  intelligence explain <finding-id>    Show a finding with its supporting evidence

Options (all commands):
  --repo <path>    Target repository (default: cwd)
  --db <path>      Override database path (default: <repo>/.code-spider/index.db)
  --json           Machine-readable JSON output`

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

  // code-spider-ab9
  // Token-savings instrumentation: tee stdout to measure what the cloud
  // consumed (emitted), then — for work commands only — persist an event when an
  // investigation is active. `investigate`/`export` are excluded so the savings
  // report itself doesn't pollute the thread it summarizes. We never CREATE a db
  // just to record: if no index exists yet, there is nothing to attribute.
  const RECORDING_EXCLUDED = new Set(['investigate', 'export'])
  const instrument = command !== undefined && !RECORDING_EXCLUDED.has(command)
  const origLog = console.log
  let captured = ''
  if (instrument) {
    resetLedger()
    console.log = (...as: unknown[]): void => {
      captured += as.map(a => (typeof a === 'string' ? a : String(a))).join(' ') + '\n'
      origLog(...(as as []))
    }
  }

  try {
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
    // code-spider-403
    case 'find': {
      const mod = await import('./commands/find')
      await mod.default(ctx)
      break
    }
    // code-spider-o7o
    case 'mcp': {
      const mod = await import('./commands/mcp')
      await mod.default(ctx)
      break
    }
    // code-spider-ebz
    case 'prune': {
      const mod = await import('./commands/prune')
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
    // code-spider-0ok
    case 'intelligence': {
      const mod = await import('./commands/intelligence')
      await mod.default(ctx)
      break
    }
    default: {
      console.log(USAGE)
      process.exit(1)
    }
    }
  } finally {
    if (instrument) {
      console.log = origLog
      try {
        if (existsSync(ctx.dbPath)) {
          const db = openDb(ctx.dbPath)
          const runId = Navigator.latestRunId(db, ctx.repoRoot)
          if (runId !== null) recordCommandEvent(db, runId, command as string, captured)
        }
      } catch {
        // Accounting must never break a command. Fail soft.
      }
    }
  }
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
