// code-spider-0ok
// Intelligence command family: structured findings from the analyzer suite.
// `scan` is the aggregate view; per-family subcommands (cycles, unused,
// dupes, hotspots, arch) arrive with their analyzers. See
// docs/intelligence-suite-design.md.
import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
import { FindingsStore } from '../services/findings'
import type { Finding, FindingCategory, FindingFilter } from '../services/findings'

const INTEL_USAGE = `code-spider intelligence <subcommand>

Subcommands:
  scan [--category <c>]   List findings from the latest indexed run
                          (categories: reachability|cycles|duplication|hotspots|architecture)`

const CATEGORIES: FindingCategory[] = ['reachability', 'cycles', 'duplication', 'hotspots', 'architecture']

export default async function run(ctx: CliContext): Promise<void> {
  const sub = ctx.args[0]
  if (sub !== 'scan') {
    console.error(INTEL_USAGE)
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const filter: FindingFilter = {}
  const categoryFlag = ctx.flags['category']
  if (typeof categoryFlag === 'string') {
    const category = categoryFlag.toLowerCase() as FindingCategory
    if (!CATEGORIES.includes(category)) {
      console.error(`Unknown category: ${categoryFlag} (expected ${CATEGORIES.join('|')})`)
      process.exit(1)
    }
    filter.category = category
  }

  const findings = new FindingsStore(db, runId).list(filter)
  const byCategory: Record<string, number> = {}
  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1
  }

  if (ctx.json) {
    console.log(JSON.stringify({ runId, summary: { findings: findings.length, byCategory }, findings }, null, 2))
    return
  }

  console.log(`Intelligence findings (run #${runId})`)
  console.log()
  if (findings.length === 0) {
    console.log('  (no findings)')
    return
  }
  for (const f of findings) {
    console.log(`  [${f.severity}] ${f.ruleId}  ${formatLocation(f)}`)
    console.log(`    ${f.title}`)
    console.log(`    confidence: ${f.confidence}  id: ${f.id}`)
  }
  console.log()
  console.log(`${findings.length} finding${findings.length === 1 ? '' : 's'}`)
}

function formatLocation(f: Finding): string {
  const loc = f.locations[0]
  if (!loc) return f.nodeKey ?? ''
  return loc.line !== undefined ? `${loc.path}:${loc.line}` : loc.path
}
