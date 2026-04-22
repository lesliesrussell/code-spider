import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { Exporter, type ExportFormat } from '../services/exporter'

export default async function run(ctx: CliContext): Promise<void> {
  // Usage: export report <node-ref-or-inv-id> [--format md|json]
  const subcommand = ctx.args[0]
  if (subcommand !== 'report') {
    console.error('Usage: code-spider export report <node-ref-or-inv-id> [--format md|json]')
    process.exit(1)
  }

  const ref = ctx.args[1]
  if (!ref) {
    console.error('Usage: code-spider export report <node-ref-or-inv-id> [--format md|json]')
    process.exit(1)
  }

  const formatFlag = ctx.flags['format']
  const format: ExportFormat = formatFlag === 'json' ? 'json' : 'md'

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const exporter = new Exporter(db, runId)

  // Determine if ref is an investigation id (pure integer) or a node key
  const isInvestigationId = /^\d+$/.test(ref)

  let output: string
  try {
    if (isInvestigationId) {
      output = await exporter.exportInvestigation(parseInt(ref, 10), format)
    } else {
      output = await exporter.exportNode(ref, format)
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  }

  console.log(output)
}
