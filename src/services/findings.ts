// code-spider-0ok
// Intelligence findings: shared model + persistence for the analyzer suite
// (cycles, reachability, duplication, hotspots, architecture). Fingerprints
// are the contract — stable across runs and line drift so CI and agents can
// track a finding over time. See docs/intelligence-suite-design.md.
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'

export type FindingCategory = 'reachability' | 'cycles' | 'duplication' | 'hotspots' | 'architecture'
export type FindingSeverity = 'info' | 'warning' | 'error'
export type FindingConfidence = 'low' | 'medium' | 'high'

export interface FindingLocation {
  path: string
  line?: number
  column?: number
}

export interface FindingInput {
  ruleId: string
  category: FindingCategory
  severity: FindingSeverity
  confidence: FindingConfidence
  title: string
  summary: string
  // Structural anchor for the fingerprint: what the finding is *about*
  // (symbol name, cycle membership, clone hash) — never line numbers.
  anchor: string
  nodeKey?: string
  locations: FindingLocation[]
  metrics?: Record<string, number>
  tags?: string[]
}

// Anchor is consumed by the fingerprint and not persisted — the fingerprint
// IS the durable identity, so Finding carries it instead of the raw anchor.
export interface Finding extends Omit<FindingInput, 'anchor'> {
  id: string
  fingerprint: string
}

export interface FindingFilter {
  category?: FindingCategory
  ruleId?: string
}

// Fingerprint = rule + normalized node path + structural anchor. Line numbers
// stay out so edits above a finding don't re-identify it. Backslashes
// normalize so fingerprints match across platforms.
export function computeFingerprint(ruleId: string, nodePath: string, anchor: string): string {
  const normalizedPath = nodePath.replaceAll('\\', '/')
  return createHash('sha256')
    .update(`${ruleId}\u0000${normalizedPath}\u0000${anchor}`)
    .digest('hex')
    .slice(0, 16)
}

interface FindingRow {
  id: string
  rule_id: string
  category: string
  severity: string
  confidence: string
  title: string
  summary: string
  fingerprint: string
  node_key: string | null
  locations_json: string
  metrics_json: string | null
  tags_json: string | null
}

export class FindingsStore {
  constructor(
    private db: Database,
    private runId: number
  ) {}

  add(input: FindingInput): Finding {
    const pathForPrint = input.locations[0]?.path ?? input.nodeKey ?? ''
    const fingerprint = computeFingerprint(input.ruleId, pathForPrint, input.anchor)
    const id = this.uniqueId(fingerprint)
    this.db
      .query(
        `INSERT INTO findings (id, run_id, rule_id, category, severity, confidence, title, summary, fingerprint, node_key, locations_json, metrics_json, tags_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        this.runId,
        input.ruleId,
        input.category,
        input.severity,
        input.confidence,
        input.title,
        input.summary,
        fingerprint,
        input.nodeKey ?? null,
        JSON.stringify(input.locations),
        input.metrics ? JSON.stringify(input.metrics) : null,
        input.tags ? JSON.stringify(input.tags) : null
      )
    const { anchor: _anchor, ...rest } = input
    return { ...rest, id, fingerprint }
  }

  list(filter: FindingFilter = {}): Finding[] {
    const clauses = ['run_id = ?']
    const params: Array<string | number> = [this.runId]
    if (filter.category !== undefined) {
      clauses.push('category = ?')
      params.push(filter.category)
    }
    if (filter.ruleId !== undefined) {
      clauses.push('rule_id = ?')
      params.push(filter.ruleId)
    }
    const rows = this.db
      .query(`SELECT * FROM findings WHERE ${clauses.join(' AND ')} ORDER BY category, rule_id, id`)
      .all(...params) as FindingRow[]
    return rows.map(rowToFinding)
  }

  // Ids are deterministic but run-scoped: fingerprints are intentionally
  // stable across runs, so the global primary key needs the run id baked in
  // (code-spider-cii). Within a run, the same fingerprint can legitimately
  // recur (two clone regions of one class) — ordinal suffixes in insertion
  // order keep those distinct.
  private uniqueId(fingerprint: string): string {
    const base = `fnd_r${this.runId}_${fingerprint}`
    const row = this.db
      .query('SELECT COUNT(*) AS n FROM findings WHERE run_id = ? AND fingerprint = ?')
      .get(this.runId, fingerprint) as { n: number }
    return row.n === 0 ? base : `${base}-${row.n + 1}`
  }
}

function rowToFinding(row: FindingRow): Finding {
  return {
    id: row.id,
    ruleId: row.rule_id,
    category: row.category as FindingCategory,
    severity: row.severity as FindingSeverity,
    confidence: row.confidence as FindingConfidence,
    title: row.title,
    summary: row.summary,
    fingerprint: row.fingerprint,
    ...(row.node_key !== null ? { nodeKey: row.node_key } : {}),
    locations: JSON.parse(row.locations_json) as FindingLocation[],
    ...(row.metrics_json !== null ? { metrics: JSON.parse(row.metrics_json) as Record<string, number> } : {}),
    ...(row.tags_json !== null ? { tags: JSON.parse(row.tags_json) as string[] } : {}),
  }
}
