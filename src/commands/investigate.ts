import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { InvestigationService } from '../services/investigation'

export default async function run(ctx: CliContext): Promise<void> {
  const db = openDb(ctx.dbPath)
  const svc = new InvestigationService(db)
  const subcommand = ctx.args[0]

  if (!subcommand) {
    // List all investigations
    const list = svc.list()
    if (ctx.json) {
      console.log(JSON.stringify(list, null, 2))
      return
    }
    if (list.length === 0) {
      console.log('No investigations yet. Start one with: code-spider investigate start "<question>"')
      return
    }
    console.log('Investigations')
    console.log()
    for (const inv of list) {
      console.log(`  #${String(inv.id).padEnd(4)}  [${inv.status}]  ${inv.question.slice(0, 60)}`)
      console.log(`        ${inv.nodeCount} nodes  ·  ${inv.createdAt.slice(0, 10)}`)
      console.log()
    }
    return
  }

  if (subcommand === 'start') {
    const question = ctx.args.slice(1).join(' ')
    if (!question) {
      console.error('Usage: code-spider investigate start "<question>"')
      process.exit(1)
    }
    const runId = Navigator.latestRunId(db, ctx.repoRoot) ?? undefined
    const id = svc.start(question, runId)
    if (ctx.json) {
      console.log(JSON.stringify({ id, question }))
    } else {
      console.log(`Investigation #${id} started`)
      console.log(`  ${question}`)
    }
    return
  }

  if (subcommand === 'show') {
    const idStr = ctx.args[1]
    if (!idStr) {
      console.error('Usage: code-spider investigate show <id>')
      process.exit(1)
    }
    const id = parseInt(idStr, 10)
    let detail
    try {
      detail = svc.showWithContext(id)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    if (ctx.json) {
      console.log(JSON.stringify(detail, null, 2))
      return
    }

    console.log(`Investigation #${detail.id}  [${detail.status}]`)
    console.log(`  ${detail.question}`)
    console.log()
    if (detail.summary) {
      console.log('Notes')
      console.log(`  ${detail.summary}`)
      console.log()
    }
    // code-spider-azy
    if (detail.pinnedEvidence.length > 0) {
      console.log(`Pinned Evidence (${detail.pinnedEvidence.length})`)
      for (const pin of detail.pinnedEvidence) {
        const locator = pin.locator ? ` (${pin.locator})` : ''
        const snippet = pin.snippet ? ` — ${pin.snippet}` : ''
        const noteStr = pin.note ? `  » ${pin.note}` : ''
        console.log(`  #${pin.evidenceId} [${pin.kind}] ${pin.source}${locator}${snippet}${noteStr}`)
      }
      console.log()
    }
    if (detail.nodes.length > 0) {
      console.log(`Nodes (${detail.nodes.length})`)
      for (const n of detail.nodes) {
        const statsStr = n.stats
          ? `  score:${n.score?.toFixed(2) ?? '?'} loc:${n.stats.loc} churn:${n.stats.churn}`
          : ''
        const noteStr = n.note ? `  — ${n.note}` : ''
        console.log(`  [${n.kind}] ${n.key}${statsStr}${noteStr}`)
        if (n.summary) {
          console.log(`      ${n.summary}`)
        }
        for (const section of n.markdownContext) {
          const location = section.sectionPath ?? section.docPath ?? section.docLabel
          console.log(`      doc: ${section.docLabel} :: ${section.sectionTitle}${location ? ` (${location})` : ''}`)
        }
        for (const issue of n.beadsContext) {
          const issueId = issue.issueId ?? issue.issueKey
          const status = issue.status ? ` [${issue.status}]` : ''
          console.log(`      issue: ${issueId}${status} ${issue.title}`)
        }
        for (const entry of n.gitContext) {
          const locator = entry.locator ? ` (${entry.locator})` : ''
          const snippet = entry.snippet ? ` — ${entry.snippet}` : ''
          console.log(`      git: ${entry.source}${locator}${snippet}`)
        }
      }
      console.log()
    } else {
      console.log('  (no nodes added yet)')
    }
    return
  }

  if (subcommand === 'add') {
    const idStr = ctx.args[1]
    const nodeRef = ctx.args[2]
    if (!idStr || !nodeRef) {
      console.error('Usage: code-spider investigate add <inv-id> <node-ref>')
      process.exit(1)
    }
    const id = parseInt(idStr, 10)
    const runId = Navigator.latestRunId(db, ctx.repoRoot)
    if (runId === null) {
      console.error('No index found. Run: code-spider index')
      process.exit(1)
    }
    try {
      svc.addNode(id, nodeRef, runId)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    if (ctx.json) {
      console.log(JSON.stringify({ ok: true, investigationId: id, nodeRef }))
    } else {
      console.log(`Added ${nodeRef} to investigation #${id}`)
    }
    return
  }

  // code-spider-azy
  if (subcommand === 'pin') {
    const idStr = ctx.args[1]
    const evidenceIdStr = ctx.args[2]
    if (!idStr || !evidenceIdStr) {
      console.error('Usage: code-spider investigate pin <inv-id> <evidence-id> [note]')
      console.error('Evidence ids appear in `show <node-ref>` output (and its --json).')
      process.exit(1)
    }
    const id = parseInt(idStr, 10)
    const evidenceId = parseInt(evidenceIdStr, 10)
    if (!Number.isInteger(evidenceId)) {
      console.error(`Invalid evidence id: ${evidenceIdStr}`)
      process.exit(1)
    }
    const note = ctx.args.slice(3).join(' ')
    try {
      svc.pinEvidence(id, evidenceId, note === '' ? undefined : note)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    if (ctx.json) {
      console.log(JSON.stringify({ ok: true, investigationId: id, evidenceId }))
    } else {
      console.log(`Pinned evidence #${evidenceId} to investigation #${id}`)
    }
    return
  }

  if (subcommand === 'note') {
    const idStr = ctx.args[1]
    const text = ctx.args.slice(2).join(' ')
    if (!idStr || !text) {
      console.error('Usage: code-spider investigate note <inv-id> <text>')
      process.exit(1)
    }
    const id = parseInt(idStr, 10)
    try {
      svc.addNote(id, text)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
    if (ctx.json) {
      console.log(JSON.stringify({ ok: true, investigationId: id }))
    } else {
      console.log(`Note added to investigation #${id}`)
    }
    return
  }

  console.error(`Unknown subcommand: ${subcommand}`)
  console.error('Available: start, add, pin, note, show, (none = list)')
  process.exit(1)
}
