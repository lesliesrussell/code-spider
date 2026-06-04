// code-spider-c4l
// Config-driven finding suppressions. Suppressions are analyzable objects,
// not silent black holes: an expired entry stops suppressing and announces
// itself; an entry that matches nothing announces that too. Runs right
// after the analyzers recompute findings, so matching is evaluated against
// fresh results. See docs/intelligence-suite-design.md.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import { debugLog } from '../utils/debug'

export interface SuppressionEntry {
  rule: string
  path: string
  expires?: string // ISO date; absent = never expires
  owner?: string
  reason?: string
}

// Structured entries need real YAML, not the flat section parser in
// FilesystemAdapter — Bun.YAML handles the whole config file.
export function loadSuppressions(repoRoot: string): SuppressionEntry[] {
  const configPath = join(repoRoot, '.code-spider', 'config.yaml')
  if (!existsSync(configPath)) return []
  try {
    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      intelligence?: { suppressions?: unknown }
    } | null
    const raw = parsed?.intelligence?.suppressions
    if (!Array.isArray(raw)) return []
    const entries: SuppressionEntry[] = []
    for (const item of raw) {
      if (typeof item !== 'object' || item === null) continue
      const candidate = item as Record<string, unknown>
      if (typeof candidate['rule'] !== 'string' || typeof candidate['path'] !== 'string') continue
      entries.push({
        rule: candidate['rule'],
        path: candidate['path'],
        ...(typeof candidate['expires'] === 'string' ? { expires: candidate['expires'] } : {}),
        ...(typeof candidate['owner'] === 'string' ? { owner: candidate['owner'] } : {}),
        ...(typeof candidate['reason'] === 'string' ? { reason: candidate['reason'] } : {}),
      })
    }
    return entries
  } catch (err) {
    debugLog('suppressions', `failed to parse ${configPath}`, err)
    return []
  }
}

interface FindingRow {
  id: string
  rule_id: string
  locations_json: string
}

export function applySuppressions(
  db: Database,
  runId: number,
  entries: SuppressionEntry[],
  now: Date = new Date()
): void {
  // Recompute stale-suppression findings from scratch each pass.
  purgeFindings(db, runId, { ruleId: 'stale-suppression' })
  if (entries.length === 0) return

  const findings = db
    .query(`SELECT id, rule_id, locations_json FROM findings WHERE run_id = ?`)
    .all(runId) as FindingRow[]
  const today = now.toISOString().slice(0, 10)
  const store = new FindingsStore(db, runId)

  for (const entry of entries) {
    const expired = entry.expires !== undefined && entry.expires < today
    const glob = new Bun.Glob(entry.path)
    const matched = findings.filter(f => {
      if (f.rule_id !== entry.rule) return false
      const locations = JSON.parse(f.locations_json) as Array<{ path: string }>
      const path = locations[0]?.path
      return path !== undefined && glob.match(path)
    })

    if (!expired) {
      for (const f of matched) {
        purgeFindings(db, runId, { id: f.id })
      }
    }

    const stale = expired || matched.length === 0
    if (stale) {
      const why = expired
        ? `expired ${entry.expires} and no longer suppresses anything`
        : 'matched no findings — the underlying issue may be fixed'
      store.add({
        ruleId: 'stale-suppression',
        category: 'suppressions',
        severity: 'info',
        confidence: 'high',
        title: `Stale suppression: ${entry.rule} on ${entry.path}`,
        summary: `Suppression of ${entry.rule} for ${entry.path} ${why}`,
        anchor: `${entry.rule}|${entry.path}`,
        locations: [{ path: entry.path }],
        ...(entry.owner !== undefined || entry.reason !== undefined
          ? { tags: [entry.owner, entry.reason].filter((t): t is string => t !== undefined) }
          : {}),
      })
    }
  }
}
