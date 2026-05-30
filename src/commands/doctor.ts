// code-spider-7ui
import type { CliContext } from '../types'
import { DoctorService } from '../services/doctor'
import type { Check, FidelityReport } from '../services/doctor'
import { Renderer } from '../services/renderer'

function statusIcon(status: Check['status']): string {
  if (status === 'pass') return '✓'
  if (status === 'fail') return '✗'
  return '~'
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

function printChecks(render: Renderer, checks: Check[]): void {
  for (const check of checks) {
    const icon = statusIcon(check.status)
    const remedyStr = check.remedy !== undefined ? `  →  ${check.remedy}` : ''
    render.line(`  ${icon} ${pad(check.name, 16)} ${check.message}${remedyStr}`)
  }
}

function printFidelity(render: Renderer, fidelity: FidelityReport): void {
  const fidelityItems: Array<{ label: string; ok: boolean; remedy?: string }> = [
    { label: 'Structural exploration', ok: fidelity.structural },
    { label: 'Hotspot analysis', ok: fidelity.hotspot },
    { label: 'Flow heuristics', ok: fidelity.flowHeuristics },
    { label: 'Symbol navigation', ok: fidelity.symbolNavigation },
    { label: 'Semantic references', ok: fidelity.semanticRefs },
    { label: 'Diagnostics', ok: fidelity.diagnostics },
  ]

  for (const item of fidelityItems) {
    const icon = item.ok ? '✓' : '✗'
    const remedyStr = (!item.ok && item.remedy !== undefined) ? `  →  ${item.remedy}` : ''
    render.line(`  ${icon} ${item.label}${remedyStr}`)
  }
}

function printRegistrySummary(
  render: Renderer,
  detectedLanguages: string[],
  selectedAnalyzers: Array<{ language: string; analyzerId: string; tool: string; available: boolean; capabilities: string[] }>,
  selectedPlugins: Array<{ language: string; pluginId: string; available: boolean; capabilities: string[]; details?: string }>
): void {
  if (detectedLanguages.length === 0) {
    render.subheading('Detected languages')
    render.line('  (no plugin-backed languages detected)')
    render.line()
    return
  }

  render.subheading('Detected languages')
  render.line(`  ${detectedLanguages.join(', ')}`)
  render.line()

  if (selectedAnalyzers.length === 0) {
    render.subheading('Selected analyzers')
    render.line('  (no analyzers selected)')
    render.line()
  } else {
    render.subheading('Selected analyzers')
    for (const analyzer of selectedAnalyzers) {
      const status = analyzer.available ? 'available' : 'missing'
      render.line(`  ${analyzer.language}:${analyzer.analyzerId}  ${analyzer.tool}  [${status}]  ${analyzer.capabilities.join(', ')}`)
    }
    render.line()
  }

  render.subheading('Selected plugins')
  if (selectedPlugins.length === 0) {
    render.line('  (no plugins selected)')
    render.line()
    return
  }
  for (const plugin of selectedPlugins) {
    const status = plugin.available ? 'available' : 'unavailable'
    const details = plugin.details ? `  ${plugin.details}` : ''
    render.line(`  ${plugin.language}:${plugin.pluginId}  [${status}]  ${plugin.capabilities.join(', ')}${details}`)
  }
  render.line()
}

function printCoverageGroup(
  render: Renderer,
  title: string,
  coverage: Array<{
    capability: string
    mode: 'sweep' | 'on-demand'
    succeeded: boolean
    successCount: number
    attemptedCount: number
    statuses: Record<string, number>
  }>,
): void {
  render.subheading(title)
  if (coverage.length === 0) {
    render.line('  (none)')
    render.line()
    return
  }

  for (const item of coverage) {
    const icon = item.succeeded ? '✓' : '✗'
    const statusSummary = Object.entries(item.statuses)
      .map(([status, count]) => `${status}:${count}`)
      .join(', ')
    const summary = item.mode === 'on-demand'
      ? `${item.attemptedCount} queries run`
      : `${item.successCount}/${item.attemptedCount} successful`
    render.line(`  ${icon} ${item.capability}  ${summary}  [${statusSummary}]`)
  }
  render.line()
}

function printLastRunCoverage(
  render: Renderer,
  coverage: Array<{
    capability: string
    mode: 'sweep' | 'on-demand'
    succeeded: boolean
    successCount: number
    attemptedCount: number
    statuses: Record<string, number>
  }>,
): void {
  if (coverage.length === 0) {
    render.subheading('Last run analyzer activity')
    render.line('  (no analyzer execution data from the latest run)')
    render.line()
    return
  }

  const sweepCoverage = coverage.filter(item => item.mode === 'sweep')
  const onDemandCoverage = coverage.filter(item => item.mode === 'on-demand')
  printCoverageGroup(render, 'Last run sweep coverage', sweepCoverage)
  printCoverageGroup(render, 'Last run on-demand activity', onDemandCoverage)
}

function printContextEnrichers(
  render: Renderer,
  enrichers: Array<{
    name: string
    available: boolean
    observed: boolean
    details: string
  }>,
): void {
  render.heading('Context enrichers')
  if (enrichers.length === 0) {
    render.line('  (none)')
    render.line()
    return
  }

  for (const enricher of enrichers) {
    const available = enricher.available ? 'available' : 'unavailable'
    const observed = enricher.observed ? 'observed' : 'not observed'
    render.line(`  ${enricher.name.padEnd(10)}  [${available}, ${observed}]  ${enricher.details}`)
  }
  render.line()
}

export default async function run(ctx: CliContext): Promise<void> {
  const scope = ctx.args[0]
  const render = new Renderer(ctx)
  const service = new DoctorService()
  const report = await service.run(ctx.repoRoot, ctx.dbPath, scope)

  if (ctx.json) {
    render.jsonOutput(report)
    return
  }

  const repoLabel = ctx.repoRoot
  render.heading(`code-spider doctor  (${repoLabel})`)

  render.heading('Environment')
  printChecks(render, report.checks)

  printRegistrySummary(render, report.detectedLanguages, report.selectedAnalyzers, report.selectedPlugins)
  printLastRunCoverage(render, report.lastRunCoverage)
  printContextEnrichers(render, report.contextEnrichers)

  render.heading('Analysis fidelity for this repo')
  printFidelity(render, report.fidelity)

  if (!report.fidelity.semanticRefs || !report.fidelity.diagnostics) {
    render.line()
    render.line('Note: Some semantic capabilities are degraded.')
    render.line('      defs/refs results may be limited to indexed symbols.')
  }
}
