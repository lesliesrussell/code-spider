import type { CliContext } from '../types'
import { Indexer } from '../services/indexer'
import { SemanticEnricher } from '../services/semantic-enricher'
import { resolve } from 'node:path'

export default async function run(ctx: CliContext): Promise<void> {
  const targetPath = ctx.args[0] !== undefined ? resolve(ctx.args[0]) : ctx.repoRoot
  const dbPath = typeof ctx.flags['db'] === 'string'
    ? ctx.dbPath
    : resolve(targetPath, '.code-spider', 'index.db')

  console.log(`Indexing ${targetPath}...`)

  const indexer = new Indexer()
  const result = await indexer.run({
    repoRoot: targetPath,
    dbPath,
  })

  if (ctx.flags['semantic']) {
    // code-spider-mbc
    // --max-files <n> raises/lowers the enrichment cap; 0 or "all" lifts it.
    let maxFiles: number | undefined
    const maxFilesFlag = ctx.flags['max-files']
    if (maxFilesFlag !== undefined) {
      if (maxFilesFlag === 'all' || maxFilesFlag === '0') {
        maxFiles = Number.POSITIVE_INFINITY
      } else {
        const parsed = typeof maxFilesFlag === 'string' ? parseInt(maxFilesFlag, 10) : NaN
        if (!Number.isInteger(parsed) || parsed < 1) {
          console.error(`Invalid --max-files value: ${String(maxFilesFlag)} (expected a positive integer, 0, or "all")`)
          process.exit(1)
        }
        maxFiles = parsed
      }
    }

    console.log('Running semantic enrichment...')
    const enricher = new SemanticEnricher()
    const enrichResult = await enricher.run({
      repoRoot: targetPath,
      runId: result.runId,
      dbPath,
      // code-spider-mbc
      ...(maxFiles !== undefined ? { maxFiles } : {}),
    })
    if (ctx.json) {
      console.log(JSON.stringify({ ...result, enrichment: enrichResult }))
    } else {
      console.log(`✓ Semantic: ${enrichResult.symbolsAdded} symbols, ${enrichResult.diagnosticsAdded} diagnostics`)
      // code-spider-5rz
      if (enrichResult.filesSkipped > 0) {
        console.log(`  Note: ${enrichResult.filesSkipped} files beyond the enrichment cap were skipped`)
      }
    }
  } else if (ctx.json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`✓ Run #${result.runId}: ${result.fileCount} files, ${result.zoneCount} zones (${result.durationMs}ms)`)
  }
}
