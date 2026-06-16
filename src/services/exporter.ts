import { Database } from 'bun:sqlite'
import { GitAdapter } from '../adapters/git'
import { FlowDetector } from './flow-detector'
import { Navigator } from './navigator'
import { InvestigationService } from './investigation'
// code-spider-ab9
import { TokenSavingsService } from './token-savings'
import type { InvestigationSavings } from './token-savings'

export type ExportFormat = 'md' | 'json'

// code-spider-ab9
export function renderTokenSavingsMd(s: InvestigationSavings): string {
  if (s.commandCount === 0) return ''
  return [
    '## Token Savings',
    '',
    `- **Saved:** ~${s.saved.toLocaleString()} tokens across ${s.commandCount} commands`,
    `- **Ingested locally:** ~${s.ingested.toLocaleString()} tokens`,
    `- **Sent to cloud:** ~${s.emitted.toLocaleString()} tokens`,
    `- **Naive ceiling (whole-repo read):** ~${s.naiveCeiling.toLocaleString()} tokens`,
    '',
    '_Estimate — a confidence booster, not an audit._',
    '',
  ].join('\n')
}

interface SymbolRow {
  name: string
  kind: string
}

interface RunInfo {
  id: number
  repo_root: string
  repo_commit: string | null
  started_at: string
}

interface FreshnessInfo {
  runId: number
  indexTimestamp: string
  semanticTimestamp: string | null
  repoCommit: string | null
  dirtyWorktree: boolean | null
}

interface ProvenanceInfo {
  summary: 'inferred'
  evidence: 'observed'
  symbols: 'observed'
  children: 'observed'
}

interface RiskAssessment {
  level: 'low' | 'medium' | 'high'
  reasons: string[]
}

interface PhaseBoundarySummary {
  artifacts: string[]
}

export class Exporter {
  private nav: Navigator
  private invSvc: InvestigationService

  constructor(private db: Database, private runId: number) {
    this.nav = new Navigator(db, runId)
    this.invSvc = new InvestigationService(db)
  }

  private async getFreshness(): Promise<FreshnessInfo | null> {
    const runInfo = this.nav.getRunInfo() as RunInfo | null
    if (!runInfo) return null

    const semanticRow = this.db.query<{ completed_at: string | null }, [number]>(
      `SELECT r.completed_at
       FROM analyzer_runs ar
       JOIN runs r ON r.id = ar.run_id
       WHERE ar.run_id=?
       ORDER BY ar.id DESC
       LIMIT 1`
    ).get(this.runId)

    const dirtyWorktree = await new GitAdapter(runInfo.repo_root).isDirty()

    return {
      runId: runInfo.id,
      indexTimestamp: runInfo.started_at,
      semanticTimestamp: semanticRow?.completed_at ?? null,
      repoCommit: runInfo.repo_commit,
      dirtyWorktree,
    }
  }

  private getProvenance(): ProvenanceInfo {
    return {
      summary: 'inferred',
      evidence: 'observed',
      symbols: 'observed',
      children: 'observed',
    }
  }

  private getRiskAssessment(nodeId: number, score: number, churn: number): RiskAssessment {
    const signals = this.nav.getRiskSignals(nodeId)
    const reasons: string[] = []
    let severity = 0

    if (score >= 0.75) {
      severity += 2
      reasons.push(`high hotspot score (${score.toFixed(2)})`)
    } else if (score >= 0.5) {
      severity += 1
      reasons.push(`elevated hotspot score (${score.toFixed(2)})`)
    }

    if (churn >= 5) {
      severity += 1
      reasons.push(`recently high churn (${churn})`)
    }

    if (signals.edgeCount >= 5) {
      severity += 1
      reasons.push(`connected to ${signals.edgeCount} graph edges`)
    }

    if (signals.diagnosticCount > 0) {
      severity += 1
      reasons.push(`${signals.diagnosticCount} diagnostics recorded`)
    }

    const level: RiskAssessment['level'] = severity >= 2 ? 'high' : severity >= 1 ? 'medium' : 'low'
    return {
      level,
      reasons: reasons.length > 0 ? reasons : ['no elevated risk signals detected'],
    }
  }

  private async getGuidance(nodeKey: string, repoRoot: string, symbols: SymbolRow[]): Promise<string[]> {
    const flows = await new FlowDetector(this.db, this.runId).detect(repoRoot, nodeKey)
    if (flows.length > 0) {
      return flows.slice(0, 3).map(flow => `flow heuristic: ${flow.label} (${flow.kind}, confidence ${flow.confidence.toFixed(2)})`)
    }

    const fallbackSymbols = symbols
      .filter(symbol =>
        ['Class', 'Function', 'Interface', 'Method'].includes(symbol.kind) &&
        /^[A-Za-z_$][\w$]*$/.test(symbol.name)
      )
      .slice(0, 4)
      .map(symbol => symbol.name)

    if (fallbackSymbols.length === 0) {
      return ['no flow edges detected; try `code-spider related <node-ref>` for structural neighbors']
    }

    return [
      'no flow edges detected; use fallback queries for behavioral tracing:',
      ...fallbackSymbols.map(symbol => `code-spider refs ${symbol}`),
    ]
  }

  private getPhaseBoundarySummary(nodeId: number): PhaseBoundarySummary | null {
    // code-spider-w8a
    const rows = this.db.query<{ name: string | null; path: string | null }, [number, number, number, number]>(
      `SELECT s.name as name, n.path as path
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND s.node_id=?
       UNION ALL
       SELECT NULL as name, path
       FROM nodes
       WHERE run_id=? AND id=? AND kind='unit'`
    ).all(this.runId, nodeId, this.runId, nodeId)

    const haystack = rows.flatMap(row => [row.name ?? '', row.path ?? '']).join('\n').toLowerCase()
    const stages: Array<{ label: string; patterns: string[] }> = [
      { label: 'token stream', patterns: ['token', 'lexer', 'lex'] },
      { label: 'AST nodes', patterns: ['ast', 'parse', 'parser'] },
      { label: 'expanded forms', patterns: ['expand', 'macro'] },
      { label: 'IR program', patterns: ['\\bir\\b', 'lower'] },
      { label: 'bytecode', patterns: ['bytecode', 'opcode', 'emit'] },
    ]

    const detected = stages.filter(stage =>
      stage.patterns.some(pattern => new RegExp(pattern).test(haystack))
    ).map(stage => stage.label)

    if (detected.length < 2) return null
    return { artifacts: detected }
  }

  async exportNode(nodeKey: string, format: ExportFormat): Promise<string> {
    const node = this.nav.getNode(nodeKey)
    if (!node) {
      throw new Error(`Node not found: ${nodeKey}`)
    }

    const stats = this.nav.getStats(node.id)
    const evidence = this.nav.getEvidence(node.id, 20)
    const children = this.nav.getChildren(nodeKey, 'score', 20)
    const freshness = await this.getFreshness()
    const provenance = this.getProvenance()
    const risk = this.getRiskAssessment(node.id, node.score, stats.churn)
    const phaseBoundary = this.getPhaseBoundarySummary(node.id)

    const symbols = this.db.query<SymbolRow, [number, number]>(
      `SELECT name, kind FROM symbols WHERE run_id=? AND node_id=? ORDER BY name LIMIT 50`
    ).all(this.runId, node.id)
    const repoRoot = this.nav.getRunInfo()?.repo_root
    const guidance = repoRoot ? await this.getGuidance(nodeKey, repoRoot, symbols) : []

    if (format === 'json') {
      return JSON.stringify({ node, stats, freshness, provenance, risk, phaseBoundary, guidance, evidence, children, symbols }, null, 2)
    }

    // Markdown
    const recencyStr = stats.recency > 900 ? 'unknown' : `${stats.recency} days`
    const lines: string[] = []

    lines.push(`# ${node.label}  [${node.kind}]`)
    lines.push('')
    if (freshness) {
      const dirtyLabel = freshness.dirtyWorktree === null
        ? 'unknown'
        : freshness.dirtyWorktree ? 'dirty' : 'clean'
      const semanticLabel = freshness.semanticTimestamp ?? 'not available'
      lines.push(`**Freshness:** index ${freshness.indexTimestamp}  **Semantic:** ${semanticLabel}  **Worktree:** ${dirtyLabel}`)
      lines.push('')
    }
    lines.push(`**Score:** ${node.score.toFixed(2)}  **LOC:** ${stats.loc}  **Churn:** ${stats.churn}  **Recency:** ${recencyStr}`)
    lines.push('')

    lines.push('## Risk')
    lines.push(`Level: ${risk.level}`)
    for (const reason of risk.reasons) {
      lines.push(`- ${reason}`)
    }
    lines.push('')

    lines.push('## Inferred Summary')
    lines.push(node.summary ?? 'No summary available')
    lines.push('')

    if (phaseBoundary !== null) {
      lines.push('## Phase Boundaries')
      lines.push(`Artifacts crossing phases: ${phaseBoundary.artifacts.join(' -> ')}`)
      lines.push('')
    }

    const hasObservedFacts = evidence.length > 0 || symbols.length > 0 || children.length > 0
    if (hasObservedFacts) {
      lines.push('## Observed Facts')
      lines.push('')
    }

    if (evidence.length > 0) {
      lines.push('### Evidence')
      for (const e of evidence) {
        const locStr = e.locator ? ` → ${e.locator}` : ''
        const snipStr = e.snippet ? ` → ${e.snippet}` : ''
        lines.push(`- ${e.kind}: ${e.source}${locStr}${snipStr}`)
      }
      lines.push('')
    }

    if (symbols.length > 0) {
      lines.push('### Symbols')
      for (const s of symbols) {
        lines.push(`- ${s.name} (${s.kind})`)
      }
      lines.push('')
    }

    if (children.length > 0) {
      lines.push('### Children')
      for (const c of children) {
        lines.push(`- ${c.key}  score: ${c.score.toFixed(2)}`)
      }
      lines.push('')
    }

    if (guidance.length > 0) {
      lines.push('## Guidance')
      for (const item of guidance) {
        lines.push(`- ${item}`)
      }
      lines.push('')
    }

    return lines.join('\n')
  }

  async exportInvestigation(investigationId: number, format: ExportFormat): Promise<string> {
    const detail = this.invSvc.showWithContext(investigationId)
    const freshness = await this.getFreshness()

    // code-spider-ab9
    const savings = new TokenSavingsService(this.db).forInvestigation(investigationId)

    if (format === 'json') {
      return JSON.stringify({ ...detail, freshness, savings }, null, 2)
    }

    // Markdown
    const lines: string[] = []

    lines.push(`# Investigation #${detail.id}`)
    lines.push('')
    lines.push(`**Question:** ${detail.question}`)
    lines.push(`**Status:** ${detail.status}`)
    lines.push(`**Created:** ${detail.createdAt.slice(0, 10)}`)
    if (freshness) {
      const dirtyLabel = freshness.dirtyWorktree === null
        ? 'unknown'
        : freshness.dirtyWorktree ? 'dirty' : 'clean'
      const semanticLabel = freshness.semanticTimestamp ?? 'not available'
      lines.push(`**Freshness:** index ${freshness.indexTimestamp}  **Semantic:** ${semanticLabel}  **Worktree:** ${dirtyLabel}`)
    }
    lines.push('')

    if (detail.summary) {
      lines.push('## Notes')
      lines.push(detail.summary)
      lines.push('')
    }

    // code-spider-azy
    if (detail.pinnedEvidence.length > 0) {
      lines.push('## Pinned Evidence')
      for (const pin of detail.pinnedEvidence) {
        const locator = pin.locator ? ` (${pin.locator})` : ''
        const snippet = pin.snippet ? ` — ${pin.snippet}` : ''
        lines.push(`- [${pin.kind}] ${pin.source}${locator}${snippet}`)
        if (pin.note) {
          lines.push(`  > ${pin.note}`)
        }
      }
      lines.push('')
    }

    if (detail.nodes.length > 0) {
      lines.push('## Nodes Visited')
      for (const n of detail.nodes) {
        const statsStr = n.stats
          ? `  score: ${n.score?.toFixed(2) ?? '?'}  loc: ${n.stats.loc}  churn: ${n.stats.churn}`
          : ''
        lines.push(`### ${n.label}  [${n.kind}]`)
        lines.push(`Key: \`${n.key}\`${statsStr}`)
        if (n.summary) {
          lines.push('')
          lines.push(n.summary)
        }
        if (n.note) {
          lines.push('')
          lines.push(`> ${n.note}`)
        }
        if (n.markdownContext.length > 0 || n.beadsContext.length > 0 || n.gitContext.length > 0) {
          lines.push('')
          lines.push('Context')
          for (const section of n.markdownContext) {
            const location = section.sectionPath ?? section.docPath ?? section.docLabel
            lines.push(`- docs: ${section.docLabel} :: ${section.sectionTitle}${location ? ` (${location})` : ''}`)
          }
          for (const issue of n.beadsContext) {
            const issueId = issue.issueId ?? issue.issueKey
            const status = issue.status ? ` [${issue.status}]` : ''
            lines.push(`- issue: ${issueId}${status} ${issue.title}`)
          }
          for (const entry of n.gitContext) {
            const locator = entry.locator ? ` (${entry.locator})` : ''
            const snippet = entry.snippet ? ` — ${entry.snippet}` : ''
            lines.push(`- git: ${entry.source}${locator}${snippet}`)
          }
        }
        lines.push('')
      }
    } else {
      lines.push('*No nodes added yet.*')
      lines.push('')
    }

    // code-spider-ab9
    lines.push(renderTokenSavingsMd(savings))

    return lines.join('\n')
  }
}
