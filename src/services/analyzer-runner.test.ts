import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'
import { AnalyzerRunner } from './analyzer-runner'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function makeTempDbPath(name: string): string {
  return join(makeTempDir(name), 'index.db')
}

function seedRunAndNode(dbPath: string, repoRoot: string, path: string, language: string): { db: ReturnType<typeof openDb>; runId: number; nodeId: number } {
  const db = openDb(dbPath)
  db.query(
    'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
  ).run('2026-04-21T12:00:00Z', '2026-04-21T12:01:00Z', repoRoot, 'abc1234', 'test')
  db.query(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
     VALUES (1, 1, 'unit', ?, ?, ?, ?, 0, 1)`
  ).run(`unit:${path}`, path.split('/').pop() ?? path, path, language)
  return { db, runId: 1, nodeId: 1 }
}

describe('AnalyzerRunner', () => {
  test('routes symbol extraction through heuristic fallback and records attempts', async () => {
    const repoRoot = makeTempDir('code-spider-runner-symbols')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export function buildThing() {}\n')

    const dbPath = makeTempDbPath('code-spider-runner-symbols-db')
    const { db, runId, nodeId } = seedRunAndNode(dbPath, repoRoot, 'src/index.ts', 'TypeScript')

    const registry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'] },
        analyzers: [
          {
            id: 'tsserver-lsp',
            kind: 'lsp',
            tool: 'typescript-language-server',
            command: ['typescript-language-server', '--stdio'],
            capabilities: ['symbols'],
            priority: 100,
          },
          {
            id: 'ts-basic-heuristic',
            kind: 'heuristic',
            tool: 'builtin',
            command: ['heuristic-symbols'],
            capabilities: ['symbols'],
            priority: 10,
          },
        ],
      }],
    }

    const runner = new AnalyzerRunner({
      registry,
      commandExists: bin => bin === 'builtin',
    })

    runner.registerAnalyzers(db, runId, repoRoot, ['TypeScript'])
    const result = await runner.executeSymbols({
      db,
      runId,
      nodeId,
      filePath: join(repoRoot, 'src', 'index.ts'),
      repoRoot,
      language: 'TypeScript',
      target: 'src/index.ts',
    })

    expect(result.symbols.some(symbol => symbol.name === 'buildThing')).toBe(true)

    const analyzerRuns = db.query<{ capability: string; status: string }, [number]>(
      'SELECT capability, status FROM analyzer_runs WHERE run_id=? ORDER BY id ASC'
    ).all(runId)

    expect(analyzerRuns).toEqual([
      { capability: 'symbols', status: 'unavailable' },
      { capability: 'symbols', status: 'success' },
    ])
  })

  test('routes diagnostics through quality analyzers and records coverage', async () => {
    const repoRoot = makeTempDir('code-spider-runner-diags')
    writeFileSync(join(repoRoot, 'broken.zig'), 'const x = ;\n')

    const dbPath = makeTempDbPath('code-spider-runner-diags-db')
    const { db, runId, nodeId } = seedRunAndNode(dbPath, repoRoot, 'broken.zig', 'Zig')

    const registry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'zig',
        display_name: 'Zig',
        aliases: [],
        detect: { extensions: ['.zig'] },
        analyzers: [{
          id: 'zig-ast-check',
          kind: 'quality',
          tool: 'sh',
          command: ['sh', '-c', 'echo syntax error 1>&2; exit 1'],
          capabilities: ['diagnostics'],
          priority: 50,
        }],
      }],
    }

    const runner = new AnalyzerRunner({
      registry,
      commandExists: () => true,
    })

    runner.registerAnalyzers(db, runId, repoRoot, ['Zig'])
    const result = await runner.executeDiagnostics({
      db,
      runId,
      nodeId,
      filePath: join(repoRoot, 'broken.zig'),
      repoRoot,
      language: 'Zig',
      target: 'broken.zig',
    })

    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0]?.message).toContain('syntax error')

    const analyzerRun = db.query<{ capability: string; status: string }, [number]>(
      'SELECT capability, status FROM analyzer_runs WHERE run_id=? LIMIT 1'
    ).get(runId)

    expect(analyzerRun).toEqual({ capability: 'diagnostics', status: 'success' })
  })

  test('routes diagnostics through lsp analyzers and records coverage even with zero diagnostics', async () => {
    const repoRoot = makeTempDir('code-spider-runner-lsp-diags')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const answer = 42\n')

    const dbPath = makeTempDbPath('code-spider-runner-lsp-diags-db')
    const { db, runId, nodeId } = seedRunAndNode(dbPath, repoRoot, 'src/index.ts', 'TypeScript')

    const registry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'] },
        analyzers: [{
          id: 'tsserver-lsp',
          kind: 'lsp',
          tool: 'typescript-language-server',
          command: ['typescript-language-server', '--stdio'],
          capabilities: ['diagnostics'],
          priority: 100,
        }],
      }],
    }

    const runner = new AnalyzerRunner({
      registry,
      commandExists: () => true,
      lspAdapter: {
        getSymbols: async () => ({ filePath: '', symbols: [], diagnostics: [] }),
        getDiagnostics: async () => ({ diagnostics: [] }),
        getReferences: async () => ({ locations: [] }),
      },
    })

    runner.registerAnalyzers(db, runId, repoRoot, ['TypeScript'])
    const result = await runner.executeDiagnostics({
      db,
      runId,
      nodeId,
      filePath: join(repoRoot, 'src', 'index.ts'),
      repoRoot,
      language: 'TypeScript',
      target: 'src/index.ts',
    })

    expect(result.diagnostics).toEqual([])

    const analyzerRun = db.query<{ capability: string; status: string }, [number]>(
      'SELECT capability, status FROM analyzer_runs WHERE run_id=? LIMIT 1'
    ).get(runId)

    expect(analyzerRun).toEqual({ capability: 'diagnostics', status: 'success' })
  })
})
