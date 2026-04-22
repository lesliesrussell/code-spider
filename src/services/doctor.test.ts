import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { DoctorService } from './doctor'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

describe('DoctorService registry reporting', () => {
  test('reports detected languages and selected analyzers from the registry', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2))
    writeFileSync(join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2))
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const answer = 42\n')

    const report = await new DoctorService().run(
      repoRoot,
      join(repoRoot, '.code-spider', 'index.db')
    )

    expect(report.detectedLanguages).toContain('typescript')
    expect(report.detectedLanguages).toContain('javascript')
    expect(
      report.selectedAnalyzers.some(analyzer =>
        analyzer.language === 'typescript' &&
        analyzer.analyzerId === 'tsserver-lsp' &&
        analyzer.capabilities.includes('refs')
      )
    ).toBe(true)
    expect(report.lastRunCoverage).toEqual([])
    expect(report.fidelity.symbolNavigation).toBe(true)
    expect(report.fidelity.semanticRefs).toBe(true)
    expect(report.fidelity.diagnostics).toBe(true)
  })

  test('falls back when no analyzers match the repo', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-empty')
    writeFileSync(join(repoRoot, 'README.md'), '# fixture\n')

    const report = await new DoctorService().run(
      repoRoot,
      join(repoRoot, '.code-spider', 'index.db')
    )

    expect(report.detectedLanguages).toEqual([])
    expect(report.selectedAnalyzers).toEqual([])
    expect(report.lastRunCoverage).toEqual([])
    expect(report.fidelity.symbolNavigation).toBe(false)
    expect(report.fidelity.semanticRefs).toBe(false)
    expect(report.fidelity.diagnostics).toBe(false)
  })

  test('prefers last-run analyzer coverage over static availability when a run exists', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-coverage')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2))
    writeFileSync(join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2))
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export class Runner {}\n')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', 0, 1)`
    ).run()
    db.query(
      `INSERT INTO analyzers (id, run_id, language, tool_name, tool_kind, available, metadata_json)
       VALUES
         (1, 1, 'typescript', 'typescript-language-server', 'lsp', 1, '{}'),
         (2, 1, 'typescript', 'builtin', 'heuristic', 1, '{}')`
    ).run()
    db.query(
      `INSERT INTO analyzer_runs (
         run_id, analyzer_id, node_id, language, capability, status, target, duration_ms, error_message, metadata_json
       ) VALUES
         (1, 1, 1, 'typescript', 'symbols', 'success', 'src/index.ts', 12, null, '{}'),
         (1, 1, 1, 'typescript', 'refs', 'success', 'src/index.ts', 14, null, '{}'),
         (1, 1, 1, 'typescript', 'diagnostics', 'unsupported', 'src/index.ts', 1, 'unsupported', '{}')`
    ).run()

    const report = await new DoctorService().run(repoRoot, dbPath)

    expect(report.lastRunCoverage).toEqual([
      {
        capability: 'diagnostics',
        succeeded: false,
        successCount: 0,
        attemptedCount: 1,
        statuses: { unsupported: 1 },
      },
      {
        capability: 'refs',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
      {
        capability: 'symbols',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
    ])
    expect(report.fidelity.symbolNavigation).toBe(true)
    expect(report.fidelity.semanticRefs).toBe(true)
    expect(report.fidelity.diagnostics).toBe(false)
  })

  test('falls back to available refs capability when the last run never attempted refs', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-refs-fallback')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'package.json'), JSON.stringify({ name: 'fixture' }, null, 2))
    writeFileSync(join(repoRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }, null, 2))
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export class Runner {}\n')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES (1, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', 0, 1)`
    ).run()
    db.query(
      `INSERT INTO analyzers (id, run_id, language, tool_name, tool_kind, available, metadata_json)
       VALUES
         (1, 1, 'typescript', 'typescript-language-server', 'lsp', 1, '{}'),
         (2, 1, 'typescript', 'builtin', 'heuristic', 1, '{}')`
    ).run()
    db.query(
      `INSERT INTO analyzer_runs (
         run_id, analyzer_id, node_id, language, capability, status, target, duration_ms, error_message, metadata_json
       ) VALUES
         (1, 1, 1, 'typescript', 'symbols', 'success', 'src/index.ts', 12, null, '{}'),
         (1, 1, 1, 'typescript', 'diagnostics', 'success', 'src/index.ts', 4, null, '{}')`
    ).run()

    const report = await new DoctorService().run(repoRoot, dbPath)

    expect(report.lastRunCoverage).toEqual([
      {
        capability: 'diagnostics',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
      {
        capability: 'symbols',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
    ])
    expect(report.fidelity.semanticRefs).toBe(true)
  })
})
