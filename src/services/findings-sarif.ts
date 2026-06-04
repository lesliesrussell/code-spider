// code-spider-lif
// SARIF 2.1.0 emitter for findings. Fingerprints ride as
// partialFingerprints so GitHub code scanning tracks a finding across runs
// the same way our own fingerprint contract does. Pure renderer.
import type { Finding, FindingSeverity } from './findings'

export interface SarifLog {
  $schema: string
  version: '2.1.0'
  runs: Array<{
    tool: {
      driver: {
        name: string
        informationUri: string
        rules: Array<{ id: string; shortDescription: { text: string } }>
      }
    }
    results: Array<{
      ruleId: string
      level: 'note' | 'warning' | 'error'
      message: { text: string }
      partialFingerprints: Record<string, string>
      locations: Array<{
        physicalLocation: {
          artifactLocation: { uri: string }
          region?: { startLine: number }
        }
      }>
    }>
  }>
}

const LEVELS: Record<FindingSeverity, 'note' | 'warning' | 'error'> = {
  info: 'note',
  warning: 'warning',
  error: 'error',
}

export function renderFindingsSarif(findings: Finding[]): SarifLog {
  const rules = new Map<string, string>()
  for (const f of findings) {
    if (!rules.has(f.ruleId)) rules.set(f.ruleId, `${f.category}: ${f.ruleId}`)
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'code-spider',
            informationUri: 'https://github.com/lesliesrussell/code-spider',
            rules: [...rules.entries()].map(([id, text]) => ({ id, shortDescription: { text } })),
          },
        },
        results: findings.map(f => ({
          ruleId: f.ruleId,
          level: LEVELS[f.severity],
          message: { text: `${f.title}. ${f.summary} (confidence: ${f.confidence})` },
          partialFingerprints: { 'codeSpider/v1': f.fingerprint },
          locations: f.locations.map(loc => ({
            physicalLocation: {
              artifactLocation: { uri: loc.path },
              ...(loc.line !== undefined ? { region: { startLine: loc.line } } : {}),
            },
          })),
        })),
      },
    ],
  }
}
