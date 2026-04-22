import type { Database } from 'bun:sqlite'
import { Navigator, type NodeRow } from './navigator'
import { FlowDetector } from './flow-detector'

export interface RelatedResult {
  key: string
  label: string
  path: string | null
  score: number
  recency: number | null
  reasons: string[]
  signals: string[]
}

interface SymbolOverlapRow {
  node_id: number
  key: string
  label: string
  path: string | null
  shared_count: number
  sample_names: string | null
}

interface ZoneOverlapRow {
  zone_name: string
  shared_count: number
  sample_names: string | null
}

interface MarkdownOverlapRow {
  node_id: number
  key: string
  label: string
  path: string | null
  shared_sections: number
  sample_docs: string | null
  sample_sections: string | null
}

interface CochangeRow {
  node_id: number
  key: string
  label: string
  path: string | null
  cochange_weight: number
}

interface SharedIssueRow {
  node_id: number
  key: string
  label: string
  path: string | null
  issue_id: string | null
  issue_title: string
  issue_status: string | null
  issue_weight: number
}

function zoneFromPath(path: string | null): string | null {
  if (!path) return null
  const [zone] = path.split('/')
  return zone && zone !== path ? zone : null
}

function freshnessBoost(recency: number | null): number {
  if (recency === null || recency > 900) return 0
  if (recency <= 1) return 0.35
  if (recency <= 3) return 0.25
  if (recency <= 7) return 0.15
  if (recency <= 14) return 0.05
  return 0
}

export class RelatedService {
  private readonly nav: Navigator

  constructor(
    private readonly db: Database,
    private readonly runId: number,
    private readonly repoRoot: string,
  ) {
    this.nav = new Navigator(db, runId)
  }

  async getRelated(nodeRef: string, limit = 10): Promise<RelatedResult[]> {
    if (nodeRef === 'repo:.') {
      return this.getRelatedForRepo(limit)
    }
    if (nodeRef.startsWith('zone:')) {
      return this.getRelatedForZone(nodeRef, limit)
    }
    if (nodeRef.startsWith('unit:')) {
      return this.getRelatedForUnit(nodeRef, limit)
    }
    return []
  }

  private getRelatedForRepo(limit: number): RelatedResult[] {
    return this.nav.getZones(limit).map(zone => ({
      key: zone.key,
      label: zone.label,
      path: zone.path,
      score: zone.score,
      recency: null,
      reasons: ['top-level zone'],
      signals: ['topology'],
    }))
  }

  private getRelatedForZone(nodeRef: string, limit: number): RelatedResult[] {
    const zoneName = nodeRef.slice('zone:'.length)
    const rows = this.db.query<ZoneOverlapRow, [number, string, string, number]>(
      `SELECT
         substr(other.path, 1, instr(other.path, '/') - 1) AS zone_name,
         COUNT(DISTINCT lower(shared.name)) AS shared_count,
         GROUP_CONCAT(DISTINCT shared.name) AS sample_names
       FROM nodes seed
       JOIN symbols base ON base.node_id = seed.id AND base.run_id = seed.run_id
       JOIN symbols shared ON lower(shared.name) = lower(base.name) AND shared.run_id = base.run_id
       JOIN nodes other ON other.id = shared.node_id
       WHERE seed.run_id = ?
         AND seed.kind = 'unit'
         AND seed.path LIKE ?
         AND other.kind = 'unit'
         AND other.path IS NOT NULL
         AND other.path NOT LIKE ?
         AND length(shared.name) >= 4
         AND shared.kind IN ('Class', 'Interface', 'Function', 'Method', 'Variable', 'Constant')
         AND instr(other.path, '/') > 0
       GROUP BY zone_name
       HAVING zone_name IS NOT NULL AND zone_name != ''
       ORDER BY shared_count DESC, zone_name ASC
       LIMIT ?`
    ).all(this.runId, `${zoneName}/%`, `${zoneName}/%`, limit)

    return rows.map(row => {
      const sample = (row.sample_names ?? '').split(',').filter(Boolean).slice(0, 3)
      return {
        key: `zone:${row.zone_name}`,
        label: row.zone_name,
        path: row.zone_name,
        score: row.shared_count,
        recency: null,
        reasons: [
          `${row.shared_count} shared symbols`,
          ...(sample.length > 0 ? [`shared: ${sample.join(', ')}`] : []),
        ],
        signals: ['symbols'],
      }
    })
  }

  private async getRelatedForUnit(nodeRef: string, limit: number): Promise<RelatedResult[]> {
    const node = this.nav.getNode(nodeRef)
    if (node === null) return []

    const results = new Map<string, RelatedResult>()
    const zoneName = zoneFromPath(node.path)

    const overlaps = this.db.query<SymbolOverlapRow, [number, number, number]>(
      `SELECT
         other.id AS node_id,
         other.key,
         other.label,
         other.path,
         COUNT(DISTINCT lower(shared.name)) AS shared_count,
         GROUP_CONCAT(DISTINCT shared.name) AS sample_names
       FROM symbols base
       JOIN symbols shared ON lower(shared.name) = lower(base.name) AND shared.run_id = base.run_id
       JOIN nodes other ON other.id = shared.node_id
       WHERE base.run_id = ?
         AND base.node_id = ?
         AND other.id != base.node_id
         AND other.kind = 'unit'
         AND length(shared.name) >= 4
         AND shared.kind IN ('Class', 'Interface', 'Function', 'Method', 'Variable', 'Constant')
       GROUP BY other.id, other.key, other.label, other.path
       ORDER BY shared_count DESC, other.path ASC
       LIMIT ?`
    ).all(this.runId, node.id, limit * 3)

    for (const row of overlaps) {
      const sample = (row.sample_names ?? '').split(',').filter(Boolean).slice(0, 3)
      results.set(row.key, {
        key: row.key,
        label: row.label,
        path: row.path,
        score: row.shared_count,
        recency: null,
        reasons: [
          `${row.shared_count} shared symbols`,
          ...(sample.length > 0 ? [`shared: ${sample.join(', ')}`] : []),
        ],
        signals: ['symbols'],
      })
    }

    if (zoneName !== null) {
      const siblings = this.nav.getChildren(`zone:${zoneName}`, 'score', limit * 2)
      for (const sibling of siblings) {
        if (sibling.key === node.key) continue
        const existing = results.get(sibling.key)
        if (existing) {
          existing.score += 0.5
          existing.reasons.push(`same zone: ${zoneName}`)
          existing.signals.push('topology')
        } else {
          results.set(sibling.key, {
            key: sibling.key,
            label: sibling.label,
            path: sibling.path,
            score: 0.5,
            recency: null,
            reasons: [`same zone: ${zoneName}`],
            signals: ['topology'],
          })
        }
      }
    }

    const markdownLinks = this.db.query<MarkdownOverlapRow, [number, number, number, number]>(
      `SELECT
         other.id AS node_id,
         other.key,
         other.label,
         other.path,
         COUNT(DISTINCT section.id) AS shared_sections,
         GROUP_CONCAT(DISTINCT doc.label) AS sample_docs,
         GROUP_CONCAT(DISTINCT section.label) AS sample_sections
       FROM edges mention_seed
       JOIN nodes section ON section.id = mention_seed.from_node_id AND section.kind = 'doc_section'
       JOIN edges mention_other
         ON mention_other.run_id = mention_seed.run_id
        AND mention_other.kind = 'mentions'
        AND mention_other.from_node_id = section.id
       JOIN nodes other ON other.id = mention_other.to_node_id AND other.kind = 'unit'
       LEFT JOIN edges containment
         ON containment.run_id = mention_seed.run_id
        AND containment.kind = 'contains'
        AND containment.to_node_id = section.id
       LEFT JOIN nodes doc ON doc.id = containment.from_node_id AND doc.kind = 'doc'
       WHERE mention_seed.run_id = ?
         AND mention_seed.kind = 'mentions'
         AND mention_seed.to_node_id = ?
         AND other.id != ?
       GROUP BY other.id, other.key, other.label, other.path
       ORDER BY shared_sections DESC, other.path ASC
       LIMIT ?`
    ).all(this.runId, node.id, node.id, limit * 3)

    for (const row of markdownLinks) {
      const sampleDoc = (row.sample_docs ?? '').split(',').filter(Boolean)[0]
      const sampleSection = (row.sample_sections ?? '').split(',').filter(Boolean)[0]
      const reason = sampleDoc
        ? sampleSection
          ? `documented together in ${sampleDoc} > ${sampleSection}`
          : `documented together in ${sampleDoc}`
        : `${row.shared_sections} shared markdown sections`
      const existing = results.get(row.key)
      if (existing) {
        existing.score += row.shared_sections * 2
        existing.reasons.push(reason)
        existing.signals.push('docs')
      } else {
        results.set(row.key, {
          key: row.key,
          label: row.label,
          path: row.path,
          score: row.shared_sections * 2,
          recency: null,
          reasons: [reason],
          signals: ['docs'],
        })
      }
    }

    const cochanges = this.db.query<CochangeRow, [number, number, number, number]>(
      `SELECT
         other.id AS node_id,
         other.key,
         other.label,
         other.path,
         edge.weight AS cochange_weight
       FROM edges edge
       JOIN nodes other
         ON other.id = CASE
           WHEN edge.from_node_id = ? THEN edge.to_node_id
           ELSE edge.from_node_id
         END
       WHERE edge.run_id = ?
         AND edge.kind = 'changed-with'
         AND (edge.from_node_id = ? OR edge.to_node_id = ?)
         AND other.kind = 'unit'
       ORDER BY edge.weight DESC, other.path ASC`
    ).all(node.id, this.runId, node.id, node.id)

    for (const row of cochanges) {
      const count = Math.round(row.cochange_weight)
      const reason = count === 1 ? 'co-changed in 1 commit' : `co-changed in ${count} commits`
      const existing = results.get(row.key)
      if (existing) {
        existing.score += row.cochange_weight * 1.5
        existing.reasons.push(reason)
        existing.signals.push('git')
      } else {
        results.set(row.key, {
          key: row.key,
          label: row.label,
          path: row.path,
          score: row.cochange_weight * 1.5,
          recency: null,
          reasons: [reason],
          signals: ['git'],
        })
      }
    }

    const sharedIssues = this.db.query<SharedIssueRow, [number, number, number]>(
      `SELECT
         other.id AS node_id,
         other.key,
         other.label,
         other.path,
         issue.path AS issue_id,
         issue.label AS issue_title,
         json_extract(issue.metadata_json, '$.status') AS issue_status,
         issue_to_other.weight AS issue_weight
       FROM edges issue_to_seed
       JOIN nodes issue ON issue.id = issue_to_seed.from_node_id AND issue.kind = 'issue'
       JOIN edges issue_to_other
         ON issue_to_other.run_id = issue_to_seed.run_id
        AND issue_to_other.kind = 'tracked-by'
        AND issue_to_other.from_node_id = issue.id
       JOIN nodes other ON other.id = issue_to_other.to_node_id AND other.kind = 'unit'
       WHERE issue_to_seed.run_id = ?
         AND issue_to_seed.kind = 'tracked-by'
         AND issue_to_seed.to_node_id = ?
         AND other.id != ?
       ORDER BY issue_to_other.weight DESC, other.path ASC`
    ).all(this.runId, node.id, node.id)

    for (const row of sharedIssues) {
      const issueId = row.issue_id ?? row.issue_title
      const suffix = row.issue_status ? ` (${row.issue_status})` : ''
      const reason = `tracked together by ${issueId}${suffix}`
      const existing = results.get(row.key)
      if (existing) {
        existing.score += row.issue_weight
        existing.reasons.push(reason)
        existing.signals.push('issues')
      } else {
        results.set(row.key, {
          key: row.key,
          label: row.label,
          path: row.path,
          score: row.issue_weight,
          recency: null,
          reasons: [reason],
          signals: ['issues'],
        })
      }
    }

    const flows = await new FlowDetector(this.db, this.runId).detect(this.repoRoot, nodeRef)
    for (const flow of flows) {
      for (const flowNodeKey of flow.nodes) {
        if (flowNodeKey === node.key) continue
        const flowNode = this.nav.getNode(flowNodeKey)
        if (flowNode === null) continue
        const existing = results.get(flowNode.key)
        if (existing) {
          existing.score += 3
          existing.reasons.push(`shared flow: ${flow.label}`)
          existing.signals.push('flows')
        } else {
          results.set(flowNode.key, {
            key: flowNode.key,
            label: flowNode.label,
            path: flowNode.path,
            score: 3,
            recency: null,
            reasons: [`shared flow: ${flow.label}`],
            signals: ['flows'],
          })
        }
      }
    }

    return [...results.values()]
      .map(result => {
        const resolved = this.nav.getNode(result.key)
        const recency = resolved ? this.nav.getStats(resolved.id).recency : null
        const boost = freshnessBoost(recency)
        const uniqueSignals = [...new Set(result.signals)]
        const uniqueReasons = [...new Set(result.reasons)]
        if (recency !== null && recency <= 14) {
          uniqueReasons.push(`recently touched (${recency === 0 ? 'today' : `${recency}d`})`)
        }
        return {
          ...result,
          score: result.score + boost,
          recency,
          reasons: uniqueReasons,
          signals: uniqueSignals,
        }
      })
      .filter(result => !(result.signals.length === 1 && result.signals[0] === 'topology'))
      .sort((a, b) =>
        b.score - a.score ||
        (a.recency ?? 999) - (b.recency ?? 999) ||
        (a.path ?? a.label).localeCompare(b.path ?? b.label)
      )
      .slice(0, limit)
  }
}
