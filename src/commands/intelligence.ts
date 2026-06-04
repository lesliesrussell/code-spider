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
// code-spider-cii
import { ReachabilityAnalyzer } from '../services/reachability'
// code-spider-c4l
import { loadSuppressions, applySuppressions } from '../services/suppressions'
// code-spider-9kx
import { DuplicationAnalyzer, loadDuplicationOptions } from '../services/duplication'

const INTEL_USAGE = `code-spider intelligence <subcommand>

Subcommands:
  scan [--category <c>]   Run all intelligence analyzers and list findings
                          (categories: reachability|cycles|duplication|hotspots|architecture)
  cycles                  Detect circular dependencies in the import graph
  unused                  Find files unreachable from configured entrypoints
  dupes                   Detect duplicated files and regions (strict token match)`

const CATEGORIES: FindingCategory[] = ['reachability', 'cycles', 'duplication', 'hotspots', 'architecture', 'suppressions']

// code-spider-q6b
// Analyzers run fail-soft: one crashing records a warning and the rest of
// the scan proceeds — never poison the session.
export type IntelAnalyzer = {
  name: string
  category: FindingCategory
  run: (db: ReturnType<typeof openDb>, runId: number, repoRoot: string) => void | Promise<void>
}

const ANALYZERS: IntelAnalyzer[] = [
  { name: 'cycles', category: 'cycles', run: (db, runId) => void new CycleAnalyzer().analyze(db, runId) },
  // code-spider-cii
  {
    name: 'reachability',
    category: 'reachability',
    run: (db, runId) => {
      const { roots } = new ReachabilityAnalyzer().analyze(db, runId)
      if (roots === 0) {
        console.error(
          'note: no entrypoints configured — unused-file analysis skipped (set intelligence.entrypoints in .code-spider/config.yaml and re-index)'
        )
      }
    },
  },
  // code-spider-9kx
  {
    name: 'duplication',
    category: 'duplication',
    run: async (db, runId, repoRoot) =>
      void (await new DuplicationAnalyzer().analyze(db, runId, loadDuplicationOptions(repoRoot))),
  },
]

export async function runAnalyzers(
  db: ReturnType<typeof openDb>,
  runId: number,
  repoRoot: string,
  only?: FindingCategory,
  analyzers: IntelAnalyzer[] = ANALYZERS
): Promise<void> {
  for (const analyzer of analyzers) {
    if (only !== undefined && analyzer.category !== only) continue
    try {
      await analyzer.run(db, runId, repoRoot)
    } catch (err) {
      console.error(`warning: ${analyzer.name} analyzer failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}

export default async function run(ctx: CliContext): Promise<void> {
  const sub = ctx.args[0]
  if (sub !== 'scan' && sub !== 'cycles' && sub !== 'unused' && sub !== 'dupes') {
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
  // code-spider-cii
  if (sub === 'unused') filter.category = 'reachability'
  // code-spider-9kx
  if (sub === 'dupes') filter.category = 'duplication'
  await runAnalyzers(db, runId, ctx.repoRoot, filter.category)
  // code-spider-c4l
  // Suppressions evaluate against the fresh analyzer results; stale entries
  // become findings themselves.
  applySuppressions(db, runId, loadSuppressions(ctx.repoRoot))

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
