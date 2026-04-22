import { afterEach, describe, expect, test } from 'bun:test'
import runDoctor from './doctor'
import { DoctorService } from '../services/doctor'

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

    DoctorService.prototype.run = async () => ({
      repoRoot: '/tmp/repo',
      dbExists: true,
      lastRunId: 1,
      detectedLanguages: ['typescript'],
      selectedAnalyzers: [],
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
        symbolNavigation: true,
        semanticRefs: true,
        diagnostics: true,
      },
    })

    await runDoctor({
      args: [],
      repoRoot: '/tmp/repo',
      dbPath: '/tmp/repo/.code-spider/index.db',
      json: false,
    })

    expect(lines).toContain('Last run sweep coverage')
    expect(lines).toContain('  ✓ symbols  10/12 successful  [success:10, no_result:2]')
    expect(lines).toContain('Last run on-demand activity')
    expect(lines).toContain('  ✓ refs  3 queries run  [success:3]')
  })
})
