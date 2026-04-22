import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'

function formatRecency(recency: number): string {
  if (recency > 900) return 'unknown'
  if (recency === 0) return 'today'
  if (recency === 1) return '1 day'
  return `${recency} days`
}

export default async function run(ctx: CliContext): Promise<void> {
  const nodeRef = ctx.args[0]
  if (!nodeRef) {
    console.error('Usage: code-spider show <node-ref>')
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const nav = new Navigator(db, runId)
  const node = nav.getNode(nodeRef)
  if (node === null) {
    console.error(`Node not found: ${nodeRef}`)
    process.exit(1)
  }

  const stats = nav.getStats(node.id)
  const children = nav.getChildren(nodeRef, 'score', 5)
  const evidence = nav.getEvidence(node.id, 5)
  const runInfo = nav.getRunInfo()
  const repoNode = nav.getRepoNode()
  const repoName = repoNode?.label ?? ctx.repoRoot.split('/').pop() ?? '.'
  const commit = runInfo?.repo_commit ? runInfo.repo_commit.slice(0, 7) : 'unknown'

  if (ctx.json) {
    console.log(JSON.stringify({
      node,
      stats,
      children,
      evidence,
    }, null, 2))
    return
  }

  // Human output
  const kindLabel = `[${node.kind}]`
  console.log(`${kindLabel} ${node.label}  (score: ${node.score.toFixed(2)})`)
  console.log()
  console.log(`  run #${runId} · ${repoName} · ${commit}`)
  console.log()

  console.log('Stats')
  const recencyStr = formatRecency(stats.recency)
  console.log(`  Files: ${String(children.length).padStart(4)}    LOC: ${String(stats.loc).padStart(6)}    Churn: ${String(stats.churn).padStart(4)}    Recency: ${recencyStr}`)
  console.log()

  if (children.length > 0) {
    console.log(`Children (top ${children.length})`)
    for (const c of children) {
      console.log(`  ${c.key.padEnd(50)}  score: ${c.score.toFixed(2)}`)
    }
    console.log()
  }

  if (evidence.length > 0) {
    console.log('Evidence')
    for (const e of evidence) {
      const locStr = e.locator ? `  ${e.locator}` : ''
      const snipStr = e.snippet ? `  → ${e.snippet}` : ''
      console.log(`  ${e.kind.padEnd(10)}  ${e.source}${locStr}${snipStr}`)
    }
    console.log()
  }
}
