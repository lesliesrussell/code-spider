// code-spider-403
// Natural-language search over embedded units. Requires `index --embed`;
// degrades with a clear message when embeddings or ollama are absent.
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { EmbeddingService } from '../services/embeddings'

export default async function run(ctx: CliContext): Promise<void> {
  const query = ctx.args.join(' ').trim()
  if (query === '') {
    console.error('Usage: code-spider find "<natural language query>" [--limit <n>]')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const limitFlag = ctx.flags['limit']
  const limit = typeof limitFlag === 'string' ? parseInt(limitFlag, 10) : 10

  const service = new EmbeddingService()
  if (!service.hasEmbeddings(db, runId)) {
    console.error('No embeddings for the latest run. Run: code-spider index --embed')
    process.exit(1)
  }

  const matches = await service.find(db, runId, query, limit)
  if (matches === null) {
    console.error('Could not embed the query — is ollama running with nomic-embed-text pulled?')
    console.error('Check: code-spider doctor')
    process.exit(1)
  }

  if (ctx.json) {
    console.log(JSON.stringify({ query, matches }, null, 2))
    return
  }

  console.log(`Find: "${query}"  (run #${runId})`)
  console.log()
  if (matches.length === 0) {
    console.log('  (no matches)')
    return
  }
  for (const match of matches) {
    console.log(`  ${match.score.toFixed(3)}  ${match.key.padEnd(50)}  ${match.path ?? match.label}`)
  }
}
