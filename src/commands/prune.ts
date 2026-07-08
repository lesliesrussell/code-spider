// code-spider-ebz
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { pruneRuns } from '../services/prune'

const DEFAULT_KEEP = 3

export default async function run(ctx: CliContext): Promise<void> {
  const keepFlag = ctx.flags['keep']
  let keep = DEFAULT_KEEP
  if (keepFlag !== undefined) {
    const parsed = typeof keepFlag === 'string' ? parseInt(keepFlag, 10) : NaN
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`Invalid --keep value: ${String(keepFlag)} (expected a positive integer)`)
      process.exit(1)
    }
    keep = parsed
  }
  const dryRun = ctx.flags['dry-run'] === true

  const db = openDb(ctx.dbPath)
  if (Navigator.latestRunId(db, ctx.repoRoot) === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const result = pruneRuns({ db, repoRoot: ctx.repoRoot, keep, dryRun })
  const pageSize = (db.query<{ page_size: number }, []>('PRAGMA page_size').get())?.page_size ?? 4096
  const reclaimed = (result.pagesBefore - result.pagesAfter) * pageSize

  if (ctx.json) {
    console.log(JSON.stringify({ ...result, dryRun, reclaimedBytes: reclaimed }, null, 2))
    return
  }

  if (result.deletedRunIds.length === 0) {
    console.log(`Nothing to prune: all ${result.protectedRunIds.length} runs are protected (newest, capability fallbacks, investigations, --keep ${keep})`)
    return
  }

  const verb = dryRun ? 'Would delete' : 'Deleted'
  console.log(`${verb} ${result.deletedRunIds.length} runs: ${result.deletedRunIds.join(', ')}`)
  console.log(`Protected: ${result.protectedRunIds.join(', ')}`)
  if (!dryRun) {
    console.log(`Reclaimed ${(reclaimed / (1024 * 1024)).toFixed(1)} MB`)
  }
}
