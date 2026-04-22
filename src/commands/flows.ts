import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { FlowDetector } from '../services/flow-detector'

export default async function run(ctx: CliContext): Promise<void> {
  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    if (ctx.json) {
      console.log(JSON.stringify({ error: 'No index found. Run: code-spider index' }))
    } else {
      console.error('No index found. Run: code-spider index')
    }
    process.exit(1)
  }

  const limitFlag = ctx.flags['limit']
  const limit = typeof limitFlag === 'string' ? parseInt(limitFlag, 10) : 20
  const nodeRef = ctx.args[0]

  if (nodeRef && nodeRef !== 'repo:.' && !nodeRef.startsWith('zone:')) {
    const nav = new Navigator(db, runId)
    if (nav.getNode(nodeRef) === null) {
      if (ctx.json) {
        console.log(JSON.stringify({ error: `Node not found: ${nodeRef}` }))
      } else {
        console.error(`Node not found: ${nodeRef}`)
      }
      process.exit(1)
    }
  }

  const detector = new FlowDetector(db, runId)
  const flows = await detector.detect(ctx.repoRoot, nodeRef)
  const limited = flows.slice(0, limit)

  if (ctx.json) {
    console.log(JSON.stringify(limited, null, 2))
    return
  }

  // Human output
  const nav = new Navigator(db, runId)
  const repoNode = nav.getRepoNode()
  const repoName = repoNode?.label ?? ctx.repoRoot.split('/').pop() ?? '.'
  const scopeLabel = nodeRef ? ` for ${nodeRef}` : ''

  console.log(`Flows in ${repoName}${scopeLabel} (run #${runId}) — heuristic`)
  console.log()

  if (limited.length === 0) {
    console.log('  (no flows detected)')
    return
  }

  for (const flow of limited) {
    const confStr = flow.confidence.toFixed(2)
    const nodeCount = flow.nodes.length
    console.log(`  ${flow.label.padEnd(20)}  [${flow.kind}]  confidence: ${confStr}  ${nodeCount} nodes`)
    if (nodeCount > 0) {
      const nodeList = flow.nodes.slice(0, 5).join(' · ')
      console.log(`    ${nodeList}`)
    }
    console.log()
  }
}
