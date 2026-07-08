import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../db/init'
import { DoctorService } from './doctor'
// code-spider-5jl
import { cleanupTempDirs, makeTempRepo } from '../test-helpers'

afterEach(cleanupTempDirs)

describe('DoctorService plugin reporting', () => {
  test('reports detected languages and selected analyzers from the active plugin path', async () => {
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
    expect(report.detectedLanguages).not.toContain('javascript')
    expect(
      report.selectedAnalyzers.some(analyzer =>
        analyzer.language === 'typescript' &&
        analyzer.analyzerId === 'tsserver-lsp' &&
        analyzer.capabilities.includes('refs')
      )
    ).toBe(true)
    expect(report.selectedPlugins).toEqual([
      {
        language: 'typescript',
        pluginId: 'builtin.typescript-javascript',
        available: true,
        capabilities: ['symbols', 'definitions', 'references', 'diagnostics', 'health'],
      },
    ])
    expect(report.lastRunCoverage).toEqual([])
    // code-spider-h25: tools available but no run exercised them yet -> 'warn', not 'pass'
    expect(report.fidelity.symbolNavigation).toBe('warn')
    expect(report.fidelity.semanticRefs).toBe('warn')
    expect(report.fidelity.diagnostics).toBe('warn')
    expect(report.contextEnrichers).toEqual([
      {
        name: 'git',
        available: false,
        observed: false,
        details: 'git unavailable',
      },
      {
        name: 'markdown',
        available: false,
        observed: false,
        details: 'no markdown files detected',
      },
      {
        name: 'beads',
        available: false,
        observed: false,
        // code-spider-ok8
        details: 'no beads workspace',
      },
    ])
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
    expect(report.selectedPlugins).toEqual([])
    expect(report.lastRunCoverage).toEqual([])
    // code-spider-h25: no analyzers available and nothing exercised -> 'fail'
    expect(report.fidelity.symbolNavigation).toBe('fail')
    expect(report.fidelity.semanticRefs).toBe('fail')
    expect(report.fidelity.diagnostics).toBe('fail')
    // code-spider-83v: rg may be installed, but flows are impossible without
    // a structural index — fidelity must not claim them.
    expect(report.fidelity.structural).toBe(false)
    expect(report.fidelity.flowHeuristics).toBe(false)
  })

  // code-spider-jew
  test('classifies a corrupted database and suggests a reindex', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-corrupt')
    writeFileSync(join(repoRoot, 'README.md'), '# fixture\n')
    mkdirSync(join(repoRoot, '.code-spider'), { recursive: true })
    // Garbage bytes — sqlite rejects this as 'file is not a database'
    writeFileSync(join(repoRoot, '.code-spider', 'index.db'), 'this is not a sqlite file')

    const report = await new DoctorService().run(
      repoRoot,
      join(repoRoot, '.code-spider', 'index.db')
    )

    const dbCheck = report.checks.find(check => check.name === 'database')
    expect(dbCheck?.status).toBe('fail')
    expect(dbCheck?.message).toContain('corrupted')
    expect(dbCheck?.remedy).toContain('code-spider index')
    expect(report.fidelity.structural).toBe(false)
    expect(report.fidelity.flowHeuristics).toBe(false)
    // code-spider-2ak: remedies surface as machine-readable recommendations
    expect(report.recommendations.some(item => item.includes('code-spider index'))).toBe(true)
    expect(report.recommendations.some(item => item.startsWith('database:'))).toBe(true)
  })

  // code-spider-wa3
  test('scope filters checks to the requested concern', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-scope')
    writeFileSync(join(repoRoot, 'README.md'), '# fixture\n')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const perfReport = await new DoctorService().run(repoRoot, dbPath, 'perf')
    expect(perfReport.scope).toBe('perf')
    for (const check of perfReport.checks) {
      expect(['repo-size', 'database']).toContain(check.name)
    }

    const repoReport = await new DoctorService().run(repoRoot, dbPath, 'repo')
    expect(repoReport.scope).toBe('repo')
    for (const check of repoReport.checks) {
      // code-spider-403: ollama is environment tooling
      expect(['git', 'rg', 'database', 'ollama']).toContain(check.name)
    }

    const semanticReport = await new DoctorService().run(repoRoot, dbPath, 'semantic')
    expect(semanticReport.scope).toBe('semantic')
    for (const check of semanticReport.checks) {
      // code-spider-d12: registry health belongs to the semantic scope too
      if (check.name === 'analyzer-registry') continue
      expect(check.name).toContain(':')
    }
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

    expect(report.selectedPlugins).toEqual([
      {
        language: 'typescript',
        pluginId: 'builtin.typescript-javascript',
        available: true,
        capabilities: ['symbols', 'definitions', 'references', 'diagnostics', 'health'],
      },
    ])
    expect(report.lastRunCoverage).toEqual([
      {
        capability: 'diagnostics',
        mode: 'sweep',
        succeeded: false,
        successCount: 0,
        attemptedCount: 1,
        statuses: { unsupported: 1 },
      },
      {
        capability: 'refs',
        mode: 'on-demand',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
      {
        capability: 'symbols',
        mode: 'sweep',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
    ])
    // code-spider-h25: symbols+refs exercised and succeeded -> 'pass';
    // diagnostics exercised but 'unsupported' (never succeeded) -> 'fail'
    expect(report.fidelity.symbolNavigation).toBe('pass')
    expect(report.fidelity.semanticRefs).toBe('pass')
    expect(report.fidelity.diagnostics).toBe('fail')
    expect(report.contextEnrichers).toEqual([
      {
        name: 'git',
        available: false,
        observed: false,
        details: 'evidence:0, cochange:0',
      },
      {
        name: 'markdown',
        available: false,
        observed: false,
        details: 'docs:0, sections:0, mentions:0',
      },
      {
        name: 'beads',
        available: false,
        observed: false,
        // code-spider-ok8
        details: 'no beads workspace (issues:0, tracked:0, deps:0)',
      },
    ])
  })

  test('reports refs as warn (available, unexercised) when the last run never attempted refs', async () => {
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

    expect(report.selectedPlugins).toEqual([
      {
        language: 'typescript',
        pluginId: 'builtin.typescript-javascript',
        available: true,
        capabilities: ['symbols', 'definitions', 'references', 'diagnostics', 'health'],
      },
    ])
    expect(report.lastRunCoverage).toEqual([
      {
        capability: 'diagnostics',
        mode: 'sweep',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
      {
        capability: 'symbols',
        mode: 'sweep',
        succeeded: true,
        successCount: 1,
        attemptedCount: 1,
        statuses: { success: 1 },
      },
    ])
    // code-spider-h25: refs not exercised this run, but the analyzer supports it -> 'warn'
    expect(report.fidelity.semanticRefs).toBe('warn')
    expect(report.fidelity.symbolNavigation).toBe('pass')
    expect(report.fidelity.diagnostics).toBe('pass')
  })

  test('reports observed context enrichers from the latest run', async () => {
    const repoRoot = makeTempRepo('code-spider-doctor-context')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'README.md'), '# fixture\n')
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export class Runner {}\n')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const db = openDb(dbPath)
    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', repoRoot, 'abc1234', 'test')
    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', 0, 1),
         (2, 1, 'doc', 'doc:README.md', 'README.md', 'README.md', 'Markdown', 0, 1),
         (3, 1, 'doc_section', 'doc_section:README.md#overview', 'Overview', 'README.md', 'Markdown', 0, 1),
         (4, 1, 'issue', 'issue:code-spider-4g0', 'Report context enrichers in doctor', 'code-spider-4g0', null, 0, 1)`
    ).run()
    db.query(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight)
       VALUES
         (1, 3, 1, 'mentions', 1),
         (1, 4, 1, 'tracked-by', 1),
         (1, 4, 4, 'depends-on', 1),
         (1, 1, 1, 'changed-with', 1)`
    ).run()
    db.query(
      `INSERT INTO evidence (run_id, node_id, kind, source, locator, snippet, score)
       VALUES (1, 1, 'git', 'abc1234', 'src/index.ts', 'initial commit', 1.0)`
    ).run()

    const report = await new DoctorService().run(repoRoot, dbPath)

    expect(report.selectedPlugins).toEqual([
      {
        language: 'typescript',
        pluginId: 'builtin.typescript-javascript',
        available: true,
        capabilities: ['symbols', 'definitions', 'references', 'diagnostics', 'health'],
      },
    ])
    expect(report.contextEnrichers).toEqual([
      {
        name: 'git',
        available: false,
        observed: true,
        details: 'evidence:1, cochange:1',
      },
      {
        name: 'markdown',
        available: true,
        observed: true,
        details: 'docs:1, sections:1, mentions:1',
      },
      {
        name: 'beads',
        available: false,
        observed: true,
        // code-spider-ok8
        details: 'no beads workspace (issues:1, tracked:1, deps:1)',
      },
    ])
  })
})
