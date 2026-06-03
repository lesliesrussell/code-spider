// code-spider-oun
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'
import { AnalyzerRunner } from './analyzer-runner'
import { SemanticEnricher } from './semantic-enricher'
import { Indexer } from './indexer'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// Heuristic-only registry: no subprocesses, fast and deterministic.
const HEURISTIC_REGISTRY: AnalyzerRegistryDocument = {
  version: 1,
  capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
  languages: [{
    id: 'typescript',
    display_name: 'TypeScript',
    aliases: ['ts'],
    detect: { extensions: ['.ts'] },
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

function makeEnricher(): SemanticEnricher {
  return new SemanticEnricher(new AnalyzerRunner({
    registry: HEURISTIC_REGISTRY,
    commandExists: () => false,
  }))
}

describe('SemanticEnricher incremental', () => {
  test('carries unchanged files forward and re-analyzes changed ones', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'code-spider-enricher-inc-'))
    tempDirs.push(repoRoot)
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    writeFileSync(join(repoRoot, 'alpha.ts'), 'export function alphaOne() {}\n')
    writeFileSync(join(repoRoot, 'beta.ts'), 'export function betaOne() {}\n')
    // Pin mtimes so the fingerprint is deterministic across the fast reindex.
    const pinned = new Date('2026-06-01T00:00:00Z')
    utimesSync(join(repoRoot, 'alpha.ts'), pinned, pinned)
    utimesSync(join(repoRoot, 'beta.ts'), pinned, pinned)

    const indexer = new Indexer()

    // Run 1: full enrichment.
    const run1 = await indexer.run({ repoRoot, dbPath })
    const full = await makeEnricher().run({ repoRoot, runId: run1.runId, dbPath })
    expect(full.filesCarried).toBe(0)
    expect(full.symbolsAdded).toBeGreaterThan(0)

    // Run 2: nothing changed — everything carries forward.
    const run2 = await indexer.run({ repoRoot, dbPath })
    const carried = await makeEnricher().run({ repoRoot, runId: run2.runId, dbPath, incremental: true })
    expect(carried.filesCarried).toBe(2)
    expect(carried.symbolsAdded).toBe(full.symbolsAdded)

    // Run 3: beta changed — alpha carries, beta re-analyzes with new content.
    writeFileSync(join(repoRoot, 'beta.ts'), 'export function betaOne() {}\nexport function betaTwo() {}\n')
    const run3 = await indexer.run({ repoRoot, dbPath })
    const partial = await makeEnricher().run({ repoRoot, runId: run3.runId, dbPath, incremental: true })
    expect(partial.filesCarried).toBe(1)
    expect(partial.symbolsAdded).toBe(full.symbolsAdded + 1)

    const { openDb } = await import('../db/init')
    const db = openDb(dbPath)
    const names = db.query<{ name: string }, [number]>(
      'SELECT name FROM symbols WHERE run_id=? ORDER BY name'
    ).all(run3.runId).map(row => row.name)
    expect(names).toContain('alphaOne')
    expect(names).toContain('betaTwo')
  })

  test('incremental without a previous run degrades to full enrichment', async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'code-spider-enricher-first-'))
    tempDirs.push(repoRoot)
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    writeFileSync(join(repoRoot, 'solo.ts'), 'export function solo() {}\n')

    const run1 = await new Indexer().run({ repoRoot, dbPath })
    const result = await makeEnricher().run({ repoRoot, runId: run1.runId, dbPath, incremental: true })
    expect(result.filesCarried).toBe(0)
    expect(result.symbolsAdded).toBeGreaterThan(0)
  })
})
