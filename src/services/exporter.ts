import { Database } from 'bun:sqlite'
import { Navigator } from './navigator'
import { InvestigationService } from './investigation'

export type ExportFormat = 'md' | 'json'

interface SymbolRow {
  name: string
  kind: string
}

export class Exporter {
  private nav: Navigator
  private invSvc: InvestigationService

  constructor(private db: Database, private runId: number) {
    this.nav = new Navigator(db, runId)
    this.invSvc = new InvestigationService(db)
  }

  async exportNode(nodeKey: string, format: ExportFormat): Promise<string> {
    const node = this.nav.getNode(nodeKey)
    if (!node) {
      throw new Error(`Node not found: ${nodeKey}`)
    }

    const stats = this.nav.getStats(node.id)
    const evidence = this.nav.getEvidence(node.id, 20)
    const children = this.nav.getChildren(nodeKey, 'score', 20)

    const symbols = this.db.query<SymbolRow, [number, number]>(
      `SELECT name, kind FROM symbols WHERE run_id=? AND node_id=? ORDER BY name LIMIT 50`
    ).all(this.runId, node.id)

    if (format === 'json') {
      return JSON.stringify({ node, stats, evidence, children, symbols }, null, 2)
    }

    // Markdown
    const recencyStr = stats.recency > 900 ? 'unknown' : `${stats.recency} days`
    const lines: string[] = []

    lines.push(`# ${node.label}  [${node.kind}]`)
    lines.push('')
    lines.push(`**Score:** ${node.score.toFixed(2)}  **LOC:** ${stats.loc}  **Churn:** ${stats.churn}  **Recency:** ${recencyStr}`)
    lines.push('')

    lines.push('## Summary')
    lines.push(node.summary ?? 'No summary available')
    lines.push('')

    if (evidence.length > 0) {
      lines.push('## Evidence')
      for (const e of evidence) {
        const locStr = e.locator ? ` → ${e.locator}` : ''
        const snipStr = e.snippet ? ` → ${e.snippet}` : ''
        lines.push(`- ${e.kind}: ${e.source}${locStr}${snipStr}`)
      }
      lines.push('')
    }

    if (symbols.length > 0) {
      lines.push('## Symbols')
      for (const s of symbols) {
        lines.push(`- ${s.name} (${s.kind})`)
      }
      lines.push('')
    }

    if (children.length > 0) {
      lines.push('## Children')
      for (const c of children) {
        lines.push(`- ${c.key}  score: ${c.score.toFixed(2)}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  async exportInvestigation(investigationId: number, format: ExportFormat): Promise<string> {
    const detail = this.invSvc.show(investigationId)

    if (format === 'json') {
      // Enrich nodes with stats
      const enriched = detail.nodes.map(n => {
        const node = this.nav.getNode(n.key)
        const stats = node ? this.nav.getStats(node.id) : null
        return { ...n, stats }
      })
      return JSON.stringify({ ...detail, nodes: enriched }, null, 2)
    }

    // Markdown
    const lines: string[] = []

    lines.push(`# Investigation #${detail.id}`)
    lines.push('')
    lines.push(`**Question:** ${detail.question}`)
    lines.push(`**Status:** ${detail.status}`)
    lines.push(`**Created:** ${detail.createdAt.slice(0, 10)}`)
    lines.push('')

    if (detail.summary) {
      lines.push('## Notes')
      lines.push(detail.summary)
      lines.push('')
    }

    if (detail.nodes.length > 0) {
      lines.push('## Nodes Visited')
      for (const n of detail.nodes) {
        const node = this.nav.getNode(n.key)
        const stats = node ? this.nav.getStats(node.id) : null
        const statsStr = stats
          ? `  score: ${node?.score.toFixed(2) ?? '?'}  loc: ${stats.loc}  churn: ${stats.churn}`
          : ''
        lines.push(`### ${n.label}  [${n.kind}]`)
        lines.push(`Key: \`${n.key}\`${statsStr}`)
        if (n.note) {
          lines.push('')
          lines.push(`> ${n.note}`)
        }
        lines.push('')
      }
    } else {
      lines.push('*No nodes added yet.*')
      lines.push('')
    }

    return lines.join('\n')
  }
}
