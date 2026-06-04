// code-spider-773
// Markdown findings report: grouped by category, fingerprints surfaced so
// CI can track findings across runs, evidence inline. Pure render — the
// command supplies findings and an evidence lookup.
import type { Finding, FindingEvidence } from './findings'

export function renderFindingsMarkdown(
  runId: number,
  findings: Finding[],
  getEvidence: (findingId: string) => FindingEvidence[]
): string {
  const lines: string[] = [`# Intelligence findings (run #${runId})`, '']
  if (findings.length === 0) {
    lines.push('No findings.', '')
    return lines.join('\n')
  }

  const byCategory = new Map<string, Finding[]>()
  for (const f of findings) {
    const list = byCategory.get(f.category) ?? []
    list.push(f)
    byCategory.set(f.category, list)
  }

  lines.push(`${findings.length} finding${findings.length === 1 ? '' : 's'} across ${byCategory.size} categor${byCategory.size === 1 ? 'y' : 'ies'}.`, '')

  for (const [category, group] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`## ${category}`, '')
    for (const f of group) {
      lines.push(`### [${f.severity}] ${f.ruleId} — ${f.title}`, '')
      lines.push(f.summary, '')
      lines.push(`confidence: ${f.confidence} · fingerprint: \`${f.fingerprint}\` · id: \`${f.id}\``, '')
      if (f.locations.length > 0) {
        lines.push('Locations:', '')
        for (const loc of f.locations) {
          lines.push(`- ${loc.path}${loc.line !== undefined ? `:${loc.line}` : ''}`)
        }
        lines.push('')
      }
      const evidence = getEvidence(f.id)
      if (evidence.length > 0) {
        lines.push('Evidence:', '')
        for (const e of evidence) {
          lines.push(`- ${e.kind}/${e.source}: ${e.locator ?? ''}${e.snippet !== undefined ? ` — ${e.snippet}` : ''}`)
        }
        lines.push('')
      }
      if (f.metrics !== undefined && Object.keys(f.metrics).length > 0) {
        lines.push(
          `Metrics: ${Object.entries(f.metrics)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')}`,
          ''
        )
      }
    }
  }
  return lines.join('\n')
}
