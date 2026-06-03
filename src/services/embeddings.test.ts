// code-spider-403
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { Indexer } from './indexer'
import {
  EmbeddingService,
  blobToVector,
  cosineSimilarity,
  vectorToBlob,
} from './embeddings'
import type { Embedder } from '../adapters/ollama'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// Deterministic fake: vector derived from character histogram — similar text
// yields similar vectors, no ollama needed.
class FakeEmbedder implements Embedder {
  calls = 0
  async embed(text: string): Promise<number[] | null> {
    this.calls++
    const vector = new Array<number>(26).fill(0)
    for (const char of text.toLowerCase()) {
      const index = char.charCodeAt(0) - 97
      if (index >= 0 && index < 26) vector[index]!++
    }
    return vector
  }
  async isAvailable(): Promise<{ reachable: boolean; modelPresent: boolean }> {
    return { reachable: true, modelPresent: true }
  }
}

class DeadEmbedder implements Embedder {
  async embed(): Promise<number[] | null> { return null }
  async isAvailable(): Promise<{ reachable: boolean; modelPresent: boolean }> {
    return { reachable: false, modelPresent: false }
  }
}

describe('vector blob round-trip and cosine', () => {
  test('round-trips through blob storage', () => {
    const vector = [0.25, -1.5, 3.75]
    const back = blobToVector(vectorToBlob(vector))
    expect([...back]).toEqual(vector)
  })

  test('cosine: identical=1, orthogonal=0, mismatched dims=0', () => {
    const a = Float32Array.from([1, 0, 2])
    expect(cosineSimilarity(a, a)).toBeCloseTo(1)
    expect(cosineSimilarity(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBe(0)
    expect(cosineSimilarity(a, Float32Array.from([1, 0]))).toBe(0)
  })
})

describe('EmbeddingService', () => {
  function makeRepo(): { repoRoot: string; dbPath: string } {
    const repoRoot = mkdtempSync(join(tmpdir(), 'code-spider-embed-'))
    tempDirs.push(repoRoot)
    writeFileSync(join(repoRoot, 'auth.ts'), 'export function authenticate(password: string) { /* login session token */ }\n')
    writeFileSync(join(repoRoot, 'render.ts'), 'export function drawCanvasPixels() { /* graphics colors sprites */ }\n')
    const pinned = new Date('2026-06-01T00:00:00Z')
    utimesSync(join(repoRoot, 'auth.ts'), pinned, pinned)
    utimesSync(join(repoRoot, 'render.ts'), pinned, pinned)
    return { repoRoot, dbPath: join(repoRoot, '.code-spider', 'index.db') }
  }

  test('embeds units, finds by meaning, carries forward unchanged files', async () => {
    const { repoRoot, dbPath } = makeRepo()
    const indexer = new Indexer()
    const embedder = new FakeEmbedder()
    const service = new EmbeddingService(embedder)

    const run1 = await indexer.run({ repoRoot, dbPath })
    const first = await service.embedRun({ repoRoot, runId: run1.runId, dbPath })
    expect(first.filesEmbedded).toBe(2)
    expect(first.filesFailed).toBe(0)

    const db = openDb(dbPath)
    const matches = await service.find(db, run1.runId, 'password login authentication token', 2)
    expect(matches).not.toBeNull()
    expect(matches![0]!.path).toBe('auth.ts')

    // Neighbors exclude self.
    const authNode = db.query<{ id: number }, [number, string]>(
      "SELECT id FROM nodes WHERE run_id=? AND key=?"
    ).get(run1.runId, 'unit:auth.ts')!
    const neighbors = service.neighbors(db, run1.runId, authNode.id, 5)
    expect(neighbors.every(n => n.key !== 'unit:auth.ts')).toBe(true)

    // Incremental: nothing changed — all carried, no embedder calls.
    const callsBefore = embedder.calls
    const run2 = await indexer.run({ repoRoot, dbPath })
    const second = await service.embedRun({ repoRoot, runId: run2.runId, dbPath, incremental: true })
    expect(second.filesCarried).toBe(2)
    expect(second.filesEmbedded).toBe(0)
    expect(embedder.calls).toBe(callsBefore)
  })

  test('fails soft when the embedder is dead', async () => {
    const { repoRoot, dbPath } = makeRepo()
    const run1 = await new Indexer().run({ repoRoot, dbPath })
    const service = new EmbeddingService(new DeadEmbedder())

    const result = await service.embedRun({ repoRoot, runId: run1.runId, dbPath })
    expect(result.filesEmbedded).toBe(0)
    expect(result.filesFailed).toBe(2)

    const db = openDb(dbPath)
    expect(service.hasEmbeddings(db, run1.runId)).toBe(false)
    expect(await service.find(db, run1.runId, 'anything', 5)).toBeNull()
  })
})
