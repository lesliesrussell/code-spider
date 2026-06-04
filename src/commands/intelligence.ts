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
// code-spider-p1d
import { HotspotAnalyzer, loadHotspotOptions } from '../services/hotspots'
// code-spider-ty9
import { ManifestAnalyzer } from '../services/manifest'
// code-spider-ek5
import { ArchitectureAnalyzer, loadArchitectureOptions } from '../services/architecture'
// code-spider-9cg
import { SymbolUnusedAnalyzer } from '../services/symbol-unused'

const INTEL_USAGE = `code-spider intelligence <subcommand>

Subcommands:
  scan [--category <c>]   Run all intelligence analyzers and list findings
                          (categories: reachability|cycles|duplication|hotspots|architecture)
  cycles                  Detect circular dependencies in the import graph
  unused                  Find files unreachable from configured entrypoints
  dupes                   Detect duplicated files and regions (strict token match)
  hotspots                Rank risk hotspots (complexity, centrality, churn, dupes, cycles)
  arch                    Check declared layer and boundary rules
  explain <finding-id>    Show a finding with its supporting evidence`

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
  // code-spider-ty9
  {
    name: 'manifest',
    category: 'reachability',
    run: async (db, runId) => void (await new ManifestAnalyzer().analyze(db, runId)),
  },
  // code-spider-9cg
  {
    name: 'symbol-unused',
    category: 'reachability',
    run: (db, runId) => void new SymbolUnusedAnalyzer().analyze(db, runId),
  },
  // code-spider-9kx
  {
    name: 'duplication',
    category: 'duplication',
    run: async (db, runId, repoRoot) =>
      void (await new DuplicationAnalyzer().analyze(db, runId, loadDuplicationOptions(repoRoot))),
  },
  // code-spider-ek5
  {
    name: 'architecture',
    category: 'architecture',
    run: (db, runId, repoRoot) =>
      void new ArchitectureAnalyzer().analyze(db, runId, loadArchitectureOptions(repoRoot)),
  },
  // code-spider-p1d
  // Must run after cycles and duplication: it folds their findings into the
  // composite score.
  {
    name: 'hotspots',
    category: 'hotspots',
    run: (db, runId, repoRoot) => void new HotspotAnalyzer().analyze(db, runId, loadHotspotOptions(repoRoot)),
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
  const SUBCOMMANDS = ['scan', 'cycles', 'unused', 'dupes', 'hotspots', 'arch', 'explain']
  if (sub === undefined || !SUBCOMMANDS.includes(sub)) {
    console.error(INTEL_USAGE)
    process.exit(1)
  }

  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  // code-spider-l0m
  if (sub === 'explain') {
    explainFinding(db, runId, ctx)
    return
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
  // code-spider-ek5
  if (sub === 'arch') filter.category = 'architecture'
  // code-spider-p1d
  // hotspots composes other analyzers' findings, so whenever it's the target
  // (subcommand or --category) the full pipeline runs and only the listing
  // is filtered.
  if (sub === 'hotspots') filter.category = 'hotspots'
  const analyzerFilter = filter.category === 'hotspots' ? undefined : filter.category
  await runAnalyzers(db, runId, ctx.repoRoot, analyzerFilter)
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

// code-spider-l0m
function explainFinding(db: ReturnType<typeof openDb>, runId: number, ctx: CliContext): void {
  const findingId = ctx.args[1]
  if (findingId === undefined) {
    console.error('Usage: code-spider intelligence explain <finding-id>')
    process.exit(1)
  }
  const store = new FindingsStore(db, runId)
  const finding = store.list().find(f => f.id === findingId)
  if (finding === undefined) {
    console.error(`No finding ${findingId} in run #${runId}. Run: code-spider intelligence scan`)
    process.exit(1)
  }
  const evidence = store.getEvidence(finding.id)

  if (ctx.json) {
    console.log(JSON.stringify({ runId, finding, evidence }, null, 2))
    return
  }

  console.log(`[${finding.severity}] ${finding.ruleId}  ${formatLocation(finding)}`)
  console.log(`  ${finding.title}`)
  console.log(`  ${finding.summary}`)
  console.log(`  confidence: ${finding.confidence}  fingerprint: ${finding.fingerprint}`)
  if (finding.metrics !== undefined) {
    const metrics = Object.entries(finding.metrics)
      .map(([k, v]) => `${k}=${v}`)
      .join('  ')
    console.log(`  metrics: ${metrics}`)
  }
  console.log()
  if (evidence.length === 0) {
    console.log('  (no linked evidence; locations above are the support)')
    return
  }
  console.log('Evidence')
  for (const e of evidence) {
    console.log(`  [${e.kind}/${e.source}] ${e.locator ?? ''}${e.snippet !== undefined ? `  ${e.snippet}` : ''}`)
  }
}
