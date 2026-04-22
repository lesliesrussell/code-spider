import type { CliContext } from '../types'
import { DoctorService } from '../services/doctor'
import type { Check, FidelityReport } from '../services/doctor'

function statusIcon(status: Check['status']): string {
  if (status === 'pass') return '✓'
  if (status === 'fail') return '✗'
  return '~'
}

function pad(s: string, n: number): string {
  return s.padEnd(n)
}

function printChecks(checks: Check[]): void {
  for (const check of checks) {
    const icon = statusIcon(check.status)
    const remedyStr = check.remedy !== undefined ? `  →  ${check.remedy}` : ''
    console.log(`  ${icon} ${pad(check.name, 16)} ${check.message}${remedyStr}`)
  }
}

function printFidelity(fidelity: FidelityReport): void {
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
    console.log(`  ${icon} ${item.label}${remedyStr}`)
  }
}

function printRegistrySummary(
  detectedLanguages: string[],
  selectedAnalyzers: Array<{ language: string; analyzerId: string; tool: string; available: boolean; capabilities: string[] }>
): void {
  if (detectedLanguages.length === 0) {
    console.log('Detected languages')
    console.log('  (none matched the analyzer registry)')
    console.log()
    return
  }

  console.log('Detected languages')
  console.log(`  ${detectedLanguages.join(', ')}`)
  console.log()

  if (selectedAnalyzers.length === 0) {
    console.log('Selected analyzers')
    console.log('  (no analyzers selected)')
    console.log()
    return
  }

  console.log('Selected analyzers')
  for (const analyzer of selectedAnalyzers) {
    const status = analyzer.available ? 'available' : 'missing'
    console.log(`  ${analyzer.language}:${analyzer.analyzerId}  ${analyzer.tool}  [${status}]  ${analyzer.capabilities.join(', ')}`)
  }
  console.log()
}

function printCoverageGroup(
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
  console.log(title)
  if (coverage.length === 0) {
    console.log('  (none)')
    console.log()
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
    console.log(`  ${icon} ${item.capability}  ${summary}  [${statusSummary}]`)
  }
  console.log()
}

function printLastRunCoverage(
  coverage: Array<{
    capability: string
    mode: 'sweep' | 'on-demand'
    succeeded: boolean
    successCount: number
    attemptedCount: number
    statuses: Record<string, number>
  }>
): void {
  if (coverage.length === 0) {
    console.log('Last run analyzer activity')
    console.log('  (no analyzer execution data from the latest run)')
    console.log()
    return
  }

  const sweepCoverage = coverage.filter(item => item.mode === 'sweep')
  const onDemandCoverage = coverage.filter(item => item.mode === 'on-demand')
  printCoverageGroup('Last run sweep coverage', sweepCoverage)
  printCoverageGroup('Last run on-demand activity', onDemandCoverage)
}

export default async function run(ctx: CliContext): Promise<void> {
  const scope = ctx.args[0] // 'semantic' | 'repo' | 'perf' | undefined
  const service = new DoctorService()
  const report = await service.run(ctx.repoRoot, ctx.dbPath, scope)

  if (ctx.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const repoLabel = ctx.repoRoot
  console.log(`code-spider doctor  (${repoLabel})`)
  console.log()

  console.log('Environment')
  printChecks(report.checks)
  console.log()

  printRegistrySummary(report.detectedLanguages, report.selectedAnalyzers)
  printLastRunCoverage(report.lastRunCoverage)

  console.log('Analysis fidelity for this repo')
  printFidelity(report.fidelity)
}
