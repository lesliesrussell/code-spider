import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { SemanticQueryService } from '../services/semantic-query'
import { AnalyzerRunner } from '../services/analyzer-runner'
// code-spider-ab9
import { recordIngestedNodes } from '../services/token-ledger'
import { resolve, relative } from 'node:path'

interface DefinitionOutput {
  symbol: string
  mode: 'semantic-definitions' | 'indexed-symbols'
  matches: Array<{
    path: string
    line: number | null
    column: number | null
    endLine: number | null
    endColumn: number | null
    kind: string
    containerName?: string | null
    heuristic?: boolean
  }>
  errors: string[]
  degraded: boolean
  degradationReason?: string
}

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

  const query = new SemanticQueryService(db, runId)
  const indexedMatches = query.findDefinitions(symbol)
  const definitions = query.findReferenceSeedDefinitions(symbol)
  // code-spider-ab9
  recordIngestedNodes(db, runId, [...indexedMatches.map(m => m.nodeKey), ...definitions.map(d => d.nodeKey)])
  const runner = new AnalyzerRunner()
  const semanticMatches: DefinitionOutput['matches'] = []
  const errors: string[] = []

  for (const definition of definitions) {
    if (definition.path === null || definition.anchorLine === null || definition.anchorColumn === null) {
      continue
    }

    const absolutePath = resolve(ctx.repoRoot, definition.path)
    const result = await runner.executeDefinitions({
      db,
      runId,
      nodeId: definition.nodeId,
      filePath: absolutePath,
      repoRoot: ctx.repoRoot,
      language: definition.language ?? '',
      target: definition.path,
      symbol,
      position: { line: definition.anchorLine, character: definition.anchorColumn },
    })

    if (result.error) errors.push(result.error)
    for (const location of result.locations) {
      semanticMatches.push({
        path: relative(ctx.repoRoot, location.path),
        line: location.range.start.line,
        column: location.range.start.character,
        endLine: location.range.end.line,
        endColumn: location.range.end.character,
        kind: 'Definition',
      })
    }
  }

  const dedupedSemantic = semanticMatches.filter((match, index, all) =>
    all.findIndex(other =>
      other.path === match.path &&
      other.line === match.line &&
      other.column === match.column &&
      other.endLine === match.endLine &&
      other.endColumn === match.endColumn
    ) === index
  )
  const matches = dedupedSemantic.length > 0
    ? dedupedSemantic
    : indexedMatches.map(match => ({
        path: match.path ?? match.nodeKey,
        line: match.line,
        column: match.column,
        endLine: match.endLine,
        endColumn: match.endColumn,
        kind: match.kind,
        containerName: match.containerName,
        heuristic: match.heuristic,
      }))
  const mode = dedupedSemantic.length > 0 ? 'semantic-definitions' : 'indexed-symbols'
  const degraded = mode !== 'semantic-definitions'
  const degradationReason = degraded
    ? errors.length > 0
      ? `Fell back to indexed symbol definitions after semantic definitions returned no locations (${errors.join('; ')})`
      : 'Fell back to indexed symbol definitions because semantic definitions returned no locations'
    : undefined
  const response: DefinitionOutput = {
    symbol,
    mode,
    matches,
    errors,
    degraded,
    degradationReason,
  }

  if (ctx.json) {
    console.log(JSON.stringify(response, null, 2))
    return
  }

  if (matches.length === 0) {
    console.log(`No definitions found for ${symbol}`)
    return
  }

  if (degraded) {
    console.log(`Fallback definitions for ${symbol}`)
    console.log(`  ${degradationReason}`)
  } else {
    console.log(`Definitions for ${symbol}`)
  }
  console.log()

  for (const match of matches) {
    const line = match.line !== null ? match.line + 1 : '?'
    const column = match.column !== null ? match.column + 1 : '?'
    const container = match.containerName ? `  in ${match.containerName}` : ''
    const modeLabel = match.heuristic ? '  [heuristic]' : ''
    console.log(`  ${match.path}:${line}:${column}  ${match.kind}${container}${modeLabel}`)
  }
}
