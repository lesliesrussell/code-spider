import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { RelatedService } from '../services/related'

export default async function run(ctx: CliContext): Promise<void> {
  const nodeRef = ctx.args[0]
  if (!nodeRef) {
    console.error('Usage: code-spider related <node-ref>')
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

  // code-spider-tn8
  // --kind filters results to one relationship signal.
  // code-spider-403: 'meaning' = embedding similarity (requires index --embed)
  const RELATED_KINDS = ['topology', 'symbols', 'docs', 'git', 'issues', 'flows', 'meaning']
  const kindFlag = ctx.flags['kind']
  let kind: string | undefined
  if (kindFlag !== undefined) {
    if (typeof kindFlag !== 'string' || !RELATED_KINDS.includes(kindFlag)) {
      console.error(`Unknown related kind: ${String(kindFlag)}`)
      console.error(`Available: ${RELATED_KINDS.join(', ')}`)
      process.exit(1)
    }
    kind = kindFlag
  }

  const allRelated = await new RelatedService(db, runId, ctx.repoRoot).getRelated(nodeRef, limit)
  // code-spider-tn8
  const related = kind === undefined
    ? allRelated
    : allRelated.filter(item => item.signals.includes(kind))

  if (ctx.json) {
    console.log(JSON.stringify(related, null, 2))
    return
  }

  console.log(`Related to ${nodeRef}`)
  console.log()

  if (related.length === 0) {
    console.log('  (no related nodes)')
    return
  }

  for (const item of related) {
    const path = item.path ?? item.label
    const signals = item.signals.length > 0 ? `  signals: ${item.signals.join(', ')}` : ''
    const recency = item.recency !== null && item.recency <= 900 ? `  recent: ${item.recency}d` : ''
    console.log(`  ${item.key.padEnd(50)}  score: ${item.score.toFixed(2)}${recency}${signals}  ${path}`)
    for (const reason of item.reasons.slice(0, 2)) {
      console.log(`    ${reason}`)
    }
  }
}
