import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'
// code-spider-ab9
import { TokenSavingsService } from '../services/token-savings'

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

function rpad(s: string, n: number): string {
  return s.padStart(n)
}

export default async function run(ctx: CliContext): Promise<void> {
  const db = openDb(ctx.dbPath)

  // code-spider-47p
  // --run <id> selects a historical run; default stays the latest.
  let runId: number | null
  const runFlag = ctx.flags['run']
  if (runFlag !== undefined) {
    const parsed = typeof runFlag === 'string' ? parseInt(runFlag, 10) : NaN
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(`Invalid --run value: ${String(runFlag)} (expected a run id)`)
      process.exit(1)
    }
    if (!Navigator.runExists(db, ctx.repoRoot, parsed)) {
      const available = Navigator.listRunIds(db, ctx.repoRoot)
      console.error(`Run #${parsed} not found for ${ctx.repoRoot}`)
      console.error(available.length > 0 ? `Available runs: ${available.join(', ')}` : 'No completed runs. Run: code-spider index')
      process.exit(1)
    }
    runId = parsed
  } else {
    runId = Navigator.latestRunId(db, ctx.repoRoot)
  }
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const nav = new Navigator(db, runId)
  const runInfo = nav.getRunInfo()
  const repoNode = nav.getRepoNode()
  const languages = nav.getLanguageSummary()
  const zones = nav.getZones(20)
  const topUnits = nav.getTopUnits(10)
  const manifests = nav.getManifests(10)

  const repoName = repoNode?.label ?? ctx.repoRoot.split('/').pop() ?? '.'
  const commit = runInfo?.repo_commit ? runInfo.repo_commit.slice(0, 7) : 'unknown'
  const dateStr = runInfo?.started_at ? runInfo.started_at.slice(0, 10) : ''

  // code-spider-ab9
  const corpusTotal = new TokenSavingsService(db).corpusTotal()

  if (ctx.json) {
    const zonesJson = zones.map(z => {
      const zoneName = z.key.slice('zone:'.length)
      const stats = nav.getStats(z.id)
      const fileCount = nav.getZoneFileCount(zoneName)
      return { key: z.key, label: z.label, score: z.score, fileCount, loc: stats.loc }
    })
    const topFilesJson = topUnits.map(u => ({
      key: u.key,
      label: u.label,
      path: u.path,
      score: u.score,
      loc: u.loc,
      churn: u.churn,
    }))
    console.log(JSON.stringify({
      runId,
      repoRoot: ctx.repoRoot,
      commit,
      languages,
      zones: zonesJson,
      topFiles: topFilesJson,
      manifests,
      corpusIngestedTokens: corpusTotal,
    }, null, 2))
    return
  }

  // Human output
  console.log(`${repoName}  (run #${runId} · ${commit} · ${dateStr})`)
  console.log()

  if (languages.length > 0) {
    console.log('Languages')
    for (const lang of languages) {
      console.log(`  ${pad(lang.language, 14)} ${rpad(String(lang.fileCount), 4)} files   ${rpad(String(lang.loc), 6)} loc`)
    }
    console.log()
  }

  if (zones.length > 0) {
    console.log(`Zones (${zones.length})`)
    for (const z of zones) {
      const zoneName = z.key.slice('zone:'.length)
      const fileCount = nav.getZoneFileCount(zoneName)
      const stats = nav.getStats(z.id)
      const locStr = stats.loc > 0 ? `  ${rpad(String(stats.loc), 6)} loc` : ''
      console.log(`  ${pad(z.label, 14)} ${rpad(String(fileCount), 4)} files  score: ${z.score.toFixed(2)}${locStr}`)
    }
    console.log()
  }

  if (topUnits.length > 0) {
    console.log('Top files by hotspot score')
    for (const u of topUnits) {
      const locStr = u.loc > 0 ? `  loc: ${rpad(String(u.loc), 5)}` : ''
      const churnStr = u.churn > 0 ? `  churn: ${rpad(String(u.churn), 4)}` : ''
      console.log(`  ${pad(u.path ?? u.label, 40)}  score: ${u.score.toFixed(2)}${locStr}${churnStr}`)
    }
    console.log()
  }

  if (manifests.length > 0) {
    console.log('Tech stack')
    for (const m of manifests) {
      const snip = m.snippet ? `  → ${m.snippet}` : ''
      console.log(`  ${m.source}${snip}`)
    }
    console.log()
  }

  // code-spider-ab9
  if (corpusTotal > 0) {
    console.log(`  Corpus digested: ~${corpusTotal.toLocaleString()} tokens (held locally, never sent to the cloud)`)
  }
}
