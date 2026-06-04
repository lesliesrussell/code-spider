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
// code-spider-q6b
import { CycleAnalyzer } from '../services/cycles'

const INTEL_USAGE = `code-spider intelligence <subcommand>

Subcommands:
  scan [--category <c>]   Run all intelligence analyzers and list findings
                          (categories: reachability|cycles|duplication|hotspots|architecture)
  cycles                  Detect circular dependencies in the import graph`

const CATEGORIES: FindingCategory[] = ['reachability', 'cycles', 'duplication', 'hotspots', 'architecture']

// code-spider-q6b
// Analyzers run fail-soft: one crashing records a warning and the rest of
// the scan proceeds — never poison the session.
export type IntelAnalyzer = { name: string; category: FindingCategory; run: (db: ReturnType<typeof openDb>, runId: number) => void }

const ANALYZERS: IntelAnalyzer[] = [
  { name: 'cycles', category: 'cycles', run: (db, runId) => void new CycleAnalyzer().analyze(db, runId) },
]

export function runAnalyzers(
  db: ReturnType<typeof openDb>,
  runId: number,
  only?: FindingCategory,
  analyzers: IntelAnalyzer[] = ANALYZERS
): void {
  for (const analyzer of analyzers) {
    if (only !== undefined && analyzer.category !== only) continue
    try {
      analyzer.run(db, runId)
    } catch (err) {
      console.error(`warning: ${analyzer.name} analyzer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export default async function run(ctx: CliContext): Promise<void> {
  const sub = ctx.args[0]
  if (sub !== 'scan' && sub !== 'cycles') {
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
  // code-spider-q6b
  if (sub === 'cycles') filter.category = 'cycles'
  runAnalyzers(db, runId, filter.category)

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
