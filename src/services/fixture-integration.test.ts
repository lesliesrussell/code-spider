import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { SemanticEnricher } from './semantic-enricher'
import { openDb } from '../db/init'
import { SemanticQueryService } from './semantic-query'
import { AnalyzerRunner } from './analyzer-runner'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function copyFixture(name: string): string {
  const target = mkdtempSync(join(tmpdir(), `code-spider-fixture-${name}-`))
  tempDirs.push(target)
  const source = resolve('test', 'fixtures', name)
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
  return target
}

describe('fixture-backed semantic integration', () => {
  test('indexes and semantically enriches a TypeScript fixture repo', async () => {
    const repoRoot = copyFixture('typescript-mini')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    expect(indexResult.fileCount).toBeGreaterThanOrEqual(3)

    const heuristicRegistry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'], manifests: ['package.json', 'tsconfig.json'] },
        analyzers: [{
          id: 'ts-basic-heuristic',
          kind: 'heuristic',
          tool: 'builtin',
          command: ['heuristic-symbols'],
          capabilities: ['symbols'],
          priority: 10,
        }],
      }],
    }

    const enrichResult = await new SemanticEnricher(new AnalyzerRunner({
      registry: heuristicRegistry,
      commandExists: () => false,
    })).run({
      repoRoot,
      runId: indexResult.runId,
      dbPath,
    })
    expect(enrichResult.filesProcessed).toBeGreaterThanOrEqual(1)
    expect(enrichResult.symbolsAdded).toBeGreaterThan(0)

    const db = openDb(dbPath)
    const query = new SemanticQueryService(db, indexResult.runId)

    const defs = query.findDefinitions('ExampleService')
    expect(defs.length).toBeGreaterThan(0)
    expect(defs[0]?.path).toBe('src/index.ts')

    const indexedRefs = query.findIndexedReferences('ExampleService')
    expect(indexedRefs.length).toBeGreaterThan(0)
    expect(indexedRefs.some(ref => ref.path === 'src/index.ts')).toBe(true)

    const coverageRows = db.query<{ capability: string; status: string; count: number }, [number]>(
      `SELECT capability, status, COUNT(*) as count
       FROM analyzer_runs
       WHERE run_id=?
       GROUP BY capability, status`
    ).all(indexResult.runId)

    expect(coverageRows.some(row => row.capability === 'symbols' && row.status === 'success')).toBe(true)
  })

  test('detects Zig fixture files and manifests as Zig instead of Other', async () => {
    const repoRoot = copyFixture('zig-mini')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    const db = openDb(dbPath)

    const languages = db.query<{ language: string; count: number }, [number]>(
      `SELECT language, COUNT(*) as count
       FROM nodes
       WHERE run_id=? AND kind='unit'
       GROUP BY language
       ORDER BY count DESC`
    ).all(indexResult.runId)

    const manifests = db.query<{ source: string; snippet: string | null }, [number]>(
      `SELECT source, snippet
       FROM evidence
       WHERE run_id=? AND kind='manifest'
       ORDER BY source ASC`
    ).all(indexResult.runId)

    expect(languages.some(row => row.language === 'Zig')).toBe(true)
    expect(manifests.some(row => row.snippet === 'build.zig')).toBe(true)
    expect(manifests.some(row => row.snippet === 'build.zig.zon')).toBe(true)
  })
})
