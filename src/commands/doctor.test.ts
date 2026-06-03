import { afterEach, describe, expect, test } from 'bun:test'
import runDoctor from './doctor'
import { DoctorService } from '../services/doctor'
// code-spider-w8a
import type { DoctorReport } from '../services/doctor'

describe('doctor command', () => {
  const originalRun = DoctorService.prototype.run
  const originalLog = console.log
  const originalError = console.error

  afterEach(() => {
    DoctorService.prototype.run = originalRun
    console.log = originalLog
    console.error = originalError
  })

  test('prints sweep coverage separately from on-demand activity', async () => {
    const lines: string[] = []
    console.log = (...args: unknown[]) => {
      lines.push(args.join(' '))
    }
    console.error = () => {}

    // code-spider-w8a
    DoctorService.prototype.run = async (): Promise<DoctorReport> => ({
      repoRoot: '/tmp/repo',
      // code-spider-wa3
      scope: null,
      dbExists: true,
      lastRunId: 1,
      detectedLanguages: ['typescript'],
      selectedAnalyzers: [],
      selectedPlugins: [
        {
          language: 'typescript',
          pluginId: 'builtin.typescript-javascript',
          available: true,
          capabilities: ['symbols', 'definitions', 'references', 'diagnostics', 'health'],
          details: 'typescript-language-server',
        },
      ],
      lastRunCoverage: [
        {
          capability: 'symbols',
          mode: 'sweep',
          succeeded: true,
          successCount: 10,
          attemptedCount: 12,
          statuses: { success: 10, no_result: 2 },
        },
        {
          capability: 'refs',
          mode: 'on-demand',
          succeeded: true,
          successCount: 3,
          attemptedCount: 3,
          statuses: { success: 3 },
        },
      ],
      checks: [],
      fidelity: {
        structural: true,
        hotspot: true,
        flowHeuristics: true,
        symbolNavigation: 'pass',
        semanticRefs: 'pass',
        diagnostics: 'pass',
      },
      // code-spider-2ak
      recommendations: [],
      contextEnrichers: [
        {
          name: 'git',
          available: true,
          observed: true,
          details: 'evidence:3, cochange:2',
        },
        {
          name: 'markdown',
          available: true,
          observed: false,
          details: 'docs:0, sections:0, mentions:0',
        },
      ],
    })

    await runDoctor({
      args: [],
      repoRoot: '/tmp/repo',
      dbPath: '/tmp/repo/.code-spider/index.db',
      json: false,
      // code-spider-w8a
      flags: {},
    })

    expect(lines).toContain('Last run sweep coverage')
    expect(lines).toContain('  ✓ symbols  10/12 successful  [success:10, no_result:2]')
    expect(lines).toContain('Last run on-demand activity')
    expect(lines).toContain('  ✓ refs  3 queries run  [success:3]')
    expect(lines).toContain('Selected plugins')
    expect(lines).toContain('  typescript:builtin.typescript-javascript  [available]  symbols, definitions, references, diagnostics, health  typescript-language-server')
    expect(lines).toContain('Context enrichers')
    expect(lines).toContain('  git         [available, observed]  evidence:3, cochange:2')
    expect(lines).toContain('  markdown    [available, not observed]  docs:0, sections:0, mentions:0')
  })
})
