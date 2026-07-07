import type { CliContext } from '../types'
import { Indexer } from '../services/indexer'
import { SemanticEnricher } from '../services/semantic-enricher'
// code-spider-ag4
import { Navigator } from '../services/navigator'
import { openDb } from '../db/init'
// code-spider-403
import { EmbeddingService } from '../services/embeddings'
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

  // code-spider-oun code-spider-403
  const incremental = ctx.flags['incremental'] === true
  if (incremental && !ctx.flags['semantic'] && !ctx.flags['embed']) {
    console.log('Note: --incremental affects semantic enrichment and embeddings; the structural sweep is always full. Add --semantic or --embed to benefit.')
  }

  // code-spider-403
  let enrichment: Awaited<ReturnType<SemanticEnricher['run']>> | undefined

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
      // code-spider-oun
      incremental,
    })
    if (!ctx.json) {
      // code-spider-oun
      const carriedStr = enrichResult.filesCarried > 0 ? ` (${enrichResult.filesCarried} files carried forward)` : ''
      console.log(`✓ Semantic: ${enrichResult.symbolsAdded} symbols, ${enrichResult.diagnosticsAdded} diagnostics${carriedStr}`)
      // code-spider-5rz
      if (enrichResult.filesSkipped > 0) {
        console.log(`  Note: ${enrichResult.filesSkipped} files beyond the enrichment cap were skipped`)
      }
    }
    enrichment = enrichResult
  } else if (!ctx.json) {
    console.log(`✓ Run #${result.runId}: ${result.fileCount} files, ${result.zoneCount} zones (${result.durationMs}ms)`)
    // code-spider-ag4
    const db = openDb(dbPath)
    const { runId: semanticRunId, fallbackFrom } = Navigator.resolveSemanticRunId(db, targetPath)
    if (fallbackFrom === result.runId && semanticRunId !== null) {
      console.log(`  Note: this run has no semantic data; atoms/defs/refs will fall back to run #${semanticRunId}. Add --semantic to refresh.`)
    }
  }

  // code-spider-403
  // Embeddings run last so symbol names (if --semantic ran) enrich the text.
  let embedding: Awaited<ReturnType<EmbeddingService['embedRun']>> | undefined
  if (ctx.flags['embed']) {
    if (!ctx.json) console.log('Embedding units...')
    embedding = await new EmbeddingService().embedRun({
      repoRoot: targetPath,
      runId: result.runId,
      dbPath,
      incremental,
    })
    if (!ctx.json) {
      const carried = embedding.filesCarried > 0 ? ` (${embedding.filesCarried} carried forward)` : ''
      console.log(`✓ Embeddings: ${embedding.filesEmbedded} files embedded${carried}`)
      if (embedding.filesFailed > 0) {
        console.log(`  Warning: ${embedding.filesFailed} files failed to embed — is ollama running? See: code-spider doctor`)
      }
    }
  }

  if (ctx.json) {
    console.log(JSON.stringify({
      ...result,
      ...(enrichment !== undefined ? { enrichment } : {}),
      ...(embedding !== undefined ? { embedding } : {}),
    }))
  }
}
