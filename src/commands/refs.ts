import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { SemanticQueryService } from '../services/semantic-query'
import { AnalyzerRunner } from '../services/analyzer-runner'
import { resolve, relative } from 'node:path'

export default async function run(ctx: CliContext): Promise<void> {
  const symbol = ctx.args[0]
  if (!symbol) {
    console.error('Usage: code-spider refs <symbol>')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const query = new SemanticQueryService(db, runId)
  const definitions = query.findDefinitions(symbol)
  if (definitions.length === 0) {
    const indexedMatches = query.findIndexedReferences(symbol)
    if (ctx.json) {
      console.log(JSON.stringify({
        symbol,
        mode: 'indexed-symbols',
        references: indexedMatches,
        error: `No definitions found for ${symbol}`,
      }, null, 2))
      return
    }
    console.log(`No definitions found for ${symbol}`)
    return
  }

  const runner = new AnalyzerRunner()
  const references: Array<{
    path: string
    line: number | null
    column: number | null
    endLine: number | null
    endColumn: number | null
  }> = []
  const errors: string[] = []

  for (const definition of definitions) {
    if (definition.path === null || definition.anchorLine === null || definition.anchorColumn === null) {
      continue
    }

    const absolutePath = resolve(ctx.repoRoot, definition.path)
    const result = await runner.executeReferences({
      db,
      runId,
      nodeId: definition.nodeId,
      filePath: absolutePath,
      repoRoot: ctx.repoRoot,
      language: definition.language ?? '',
      target: definition.path,
      position: { line: definition.anchorLine, character: definition.anchorColumn },
    })

    if (result.error) errors.push(result.error)
    for (const location of result.locations) {
      const path = relative(ctx.repoRoot, location.path)
      references.push({
        path,
        line: location.range.start.line,
        column: location.range.start.character,
        endLine: location.range.end.line,
        endColumn: location.range.end.character,
      })
    }
  }

  const deduped = references.filter((reference, index, all) =>
    all.findIndex(other =>
      other.path === reference.path &&
      other.line === reference.line &&
      other.column === reference.column &&
      other.endLine === reference.endLine &&
      other.endColumn === reference.endColumn
    ) === index
  )
  const fallbackReferences = deduped.length > 0 ? deduped : query.findIndexedReferences(symbol)
  const mode = deduped.length > 0 ? 'lsp-references' : 'indexed-symbols'

  if (ctx.json) {
    console.log(JSON.stringify({
      symbol,
      mode,
      definitions,
      references: fallbackReferences,
      errors,
    }, null, 2))
    return
  }

  if (fallbackReferences.length === 0) {
    console.log(`No references found for ${symbol}`)
    if (errors.length > 0) {
      console.log()
      for (const error of errors) console.log(`  ${error}`)
    }
    return
  }

  console.log(`References for ${symbol}`)
  console.log()
  for (const reference of fallbackReferences) {
    const line = reference.line !== null ? reference.line + 1 : '?'
    const column = reference.column !== null ? reference.column + 1 : '?'
    console.log(`  ${reference.path}:${line}:${column}`)
  }
}
