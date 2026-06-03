import type { CliContext } from '../types'
import { openDb } from '../db/init'
import { Navigator } from '../services/navigator'

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

function rpad(s: string, n: number): string {
  return s.padStart(n)
}

export default async function run(ctx: CliContext): Promise<void> {
  const db = openDb(ctx.dbPath)
  const runId = Navigator.latestRunId(db, ctx.repoRoot)
  if (runId === null) {
    console.error('No index found. Run: code-spider index')
    process.exit(1)
  }

  const nav = new Navigator(db, runId)
  const limitFlag = ctx.flags['limit']
  const limit = typeof limitFlag === 'string' ? parseInt(limitFlag, 10) : 20

  // code-spider-eed
  // --kind filters zones by their dominant language (persisted at index time).
  const kindFlag = ctx.flags['kind']
  const kind = typeof kindFlag === 'string' ? kindFlag.toLowerCase() : undefined
  const allZones = nav.getZones(limit)
  const zones = kind === undefined
    ? allZones
    : allZones.filter(z => (z.language ?? '').toLowerCase() === kind)
  const repoNode = nav.getRepoNode()
  const repoName = repoNode?.label ?? ctx.repoRoot.split('/').pop() ?? '.'

  if (ctx.json) {
    const result = zones.map(z => {
      const zoneName = z.key.slice('zone:'.length)
      const stats = nav.getStats(z.id)
      const fileCount = nav.getZoneFileCount(zoneName)
      // code-spider-eed
      return { key: z.key, label: z.label, language: z.language, score: z.score, fileCount, loc: stats.loc }
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`Zones in ${repoName} (run #${runId})`)
  console.log()

  if (zones.length === 0) {
    console.log('  (no zones found)')
    return
  }

  for (const z of zones) {
    const zoneName = z.key.slice('zone:'.length)
    const stats = nav.getStats(z.id)
    const fileCount = nav.getZoneFileCount(zoneName)
    const locStr = stats.loc > 0 ? `  ${rpad(String(stats.loc), 6)} loc` : ''
    // code-spider-eed
    const langStr = z.language ? `  [${z.language}]` : ''
    console.log(`  ${pad(z.label, 16)}  score: ${z.score.toFixed(2)}   ${rpad(String(fileCount), 4)} files${locStr}${langStr}`)
  }
  console.log()
}
