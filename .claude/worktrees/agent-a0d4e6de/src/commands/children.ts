import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'

export default async function run(ctx: CliContext): Promise<void> {
  const nodeRef = ctx.args[0]
  if (!nodeRef) {
    console.error('Usage: code-spider children <node-ref>')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const limitFlag = ctx.flags['limit']
  const limit = typeof limitFlag === 'string' ? parseInt(limitFlag, 10) : 20

  const sortFlag = ctx.flags['sort']
  const validSorts = ['score', 'churn', 'loc', 'recent'] as const
  type SortBy = typeof validSorts[number]
  const sortBy: SortBy = (typeof sortFlag === 'string' && (validSorts as readonly string[]).includes(sortFlag))
    ? (sortFlag as SortBy)
    : 'score'

  const nav = new Navigator(db, runId)
  const children = nav.getChildren(nodeRef, sortBy, limit)

  if (ctx.json) {
    const result = children.map(c => {
      const stats = nav.getStats(c.id)
      return { key: c.key, label: c.label, path: c.path, score: c.score, ...stats }
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Children of ${nodeRef}  (sorted by ${sortBy})`)
  console.log()

  if (children.length === 0) {
    console.log('  (no children)')
    return
  }

  for (const c of children) {
    const stats = nav.getStats(c.id)
    const locStr = stats.loc > 0 ? `  loc: ${String(stats.loc).padStart(5)}` : ''
    const churnStr = stats.churn > 0 ? `  churn: ${String(stats.churn).padStart(4)}` : ''
    console.log(`  ${c.key.padEnd(50)}  score: ${c.score.toFixed(2)}${locStr}${churnStr}`)
  }
  console.log()
}
