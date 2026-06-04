// code-spider-773
import { describe, expect, test } from 'bun:test'
import { renderFindingsMarkdown } from './findings-report'
import type { Finding, FindingEvidence } from './findings'

function finding(overrides: Partial<Finding>): Finding {
  return {
    id: 'fnd_r1_abc',
    fingerprint: 'abc123',
    ruleId: 'circular-dependency',
    category: 'cycles',
    severity: 'warning',
    confidence: 'high',
    title: 'Circular dependency among 2 units',
    summary: 'Cycle members: src/a.ts, src/b.ts',
    locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
    ...overrides,
  }
}

describe('renderFindingsMarkdown', () => {
  test('groups findings by category with severity, confidence, and evidence', () => {
    const findings: Finding[] = [
      finding({}),
      finding({
        id: 'fnd_r1_def',
        fingerprint: 'def456',
        ruleId: 'unused-file',
        category: 'reachability',
        severity: 'warning',
        confidence: 'medium',
        title: 'Unused file: src/dead.ts',
        summary: 'src/dead.ts is not reachable',
        locations: [{ path: 'src/dead.ts', line: 1 }],
      }),
    ]
    const evidence = new Map<string, FindingEvidence[]>([
      ['fnd_r1_abc', [{ kind: 'graph', source: 'imports', locator: 'src/a.ts -> src/b.ts' }]],
    ])
    const md = renderFindingsMarkdown(7, findings, id => evidence.get(id) ?? [])

    expect(md).toContain('# Intelligence findings (run #7)')
    expect(md).toContain('## cycles')
    expect(md).toContain('## reachability')
    expect(md).toContain('### [warning] circular-dependency')
    expect(md).toContain('confidence: high')
    expect(md).toContain('`abc123`') // fingerprint, CI-trackable
    expect(md).toContain('src/dead.ts:1')
    expect(md).toContain('- graph/imports: src/a.ts -> src/b.ts')
    // category order is deterministic (alphabetical)
    expect(md.indexOf('## cycles')).toBeLessThan(md.indexOf('## reachability'))
  })

  test('empty findings render a clean report', () => {
    const md = renderFindingsMarkdown(3, [], () => [])
    expect(md).toContain('# Intelligence findings (run #3)')
    expect(md).toContain('No findings.')
    expect(md).not.toContain('##')
  })
})
