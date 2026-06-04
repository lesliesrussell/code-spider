// code-spider-lif
import { describe, expect, test } from 'bun:test'
import { renderFindingsSarif } from './findings-sarif'
import type { Finding } from './findings'

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
    locations: [{ path: 'src/a.ts' }, { path: 'src/b.ts', line: 4 }],
    ...overrides,
  }
}

describe('renderFindingsSarif', () => {
  test('emits a structurally valid SARIF 2.1.0 log', () => {
    const sarif = renderFindingsSarif([
      finding({}),
      finding({
        id: 'fnd_r1_def',
        fingerprint: 'def456',
        ruleId: 'unused-file',
        category: 'reachability',
        severity: 'info',
        title: 'Possibly unused file',
        summary: 'src/lazy.ts only dynamically reachable',
        locations: [{ path: 'src/lazy.ts', line: 1 }],
      }),
      finding({ id: 'fnd_r1_ghi', fingerprint: 'ghi789', severity: 'error' }),
    ])

    expect(sarif.version).toBe('2.1.0')
    expect(sarif.$schema).toContain('sarif')
    const run = sarif.runs[0]!
    expect(run.tool.driver.name).toBe('code-spider')
    // rules deduplicated: circular-dependency appears twice in findings
    const ruleIds = run.tool.driver.rules.map(r => r.id)
    expect(ruleIds).toEqual(['circular-dependency', 'unused-file'])

    expect(run.results).toHaveLength(3)
    const first = run.results[0]!
    expect(first.ruleId).toBe('circular-dependency')
    expect(first.level).toBe('warning')
    expect(first.message.text).toContain('Cycle members')
    expect(first.partialFingerprints['codeSpider/v1']).toBe('abc123')
    expect(first.locations[0]!.physicalLocation.artifactLocation.uri).toBe('src/a.ts')
    expect(first.locations[1]!.physicalLocation.region?.startLine).toBe(4)

    // severity mapping: info -> note, error -> error
    expect(run.results[1]!.level).toBe('note')
    expect(run.results[2]!.level).toBe('error')
  })

  test('output is byte-stable for identical input', () => {
    const a = JSON.stringify(renderFindingsSarif([finding({})]))
    const b = JSON.stringify(renderFindingsSarif([finding({})]))
    expect(b).toBe(a)
  })

  test('empty findings produce an empty results array', () => {
    const sarif = renderFindingsSarif([])
    expect(sarif.runs[0]!.results).toEqual([])
    expect(sarif.runs[0]!.tool.driver.rules).toEqual([])
  })
})
