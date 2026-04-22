import type { CliContext } from '../types'
import { Indexer } from '../services/indexer'
import { resolve } from 'node:path'

export default async function run(ctx: CliContext): Promise<void> {
  const targetPath = ctx.args[0] !== undefined ? resolve(ctx.args[0]) : ctx.repoRoot
  const incremental = Boolean(ctx.flags['incremental'])

  console.log(`Indexing ${targetPath}...`)

  const indexer = new Indexer()
  const result = await indexer.run({
    repoRoot: targetPath,
    dbPath: ctx.dbPath,
    incremental,
  })

  if (ctx.json) {
    console.log(JSON.stringify(result))
  } else {
    console.log(`✓ Run #${result.runId}: ${result.fileCount} files, ${result.zoneCount} zones (${result.durationMs}ms)`)
  }
}
