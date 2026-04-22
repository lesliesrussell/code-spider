import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { SemanticQueryService } from '../services/semantic-query'

export default async function run(ctx: CliContext): Promise<void> {
  const symbol = ctx.args[0]
  if (!symbol) {
    console.error('Usage: code-spider defs <symbol>')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const matches = new SemanticQueryService(db, runId).findDefinitions(symbol)

  if (ctx.json) {
    console.log(JSON.stringify({ symbol, matches }, null, 2))
    return
  }

  if (matches.length === 0) {
    console.log(`No definitions found for ${symbol}`)
    return
  }

  console.log(`Definitions for ${symbol}`)
  console.log()

  for (const match of matches) {
    const path = match.path ?? match.nodeKey
    const line = match.line !== null ? match.line + 1 : '?'
    const column = match.column !== null ? match.column + 1 : '?'
    const container = match.containerName ? `  in ${match.containerName}` : ''
    const mode = match.heuristic ? '  [heuristic]' : ''
    console.log(`  ${path}:${line}:${column}  ${match.kind}${container}${mode}`)
  }
}
