// code-spider-403
// Semantic embeddings over unit nodes. Embedding text is structural-only
// input (path, language, symbol names when present, file head+tail) so it
// works without --semantic and never depends on LLM-generated prose. Vectors
// are carried forward for unchanged files exactly like incremental enrichment
// (stat fingerprint in node metadata) — steady-state cost is changed files.
//
// Known limitation: one vector per file. Long files are represented by their
// sampled text, so functionality buried mid-file may rank poorly for queries
// targeting it specifically. The fix, if it ever matters enough, is chunked
// multi-vector embedding (N vectors per file, max-pool the similarity).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { openDb } from '../db/init'
import { OllamaAdapter, EMBEDDING_MODEL, type Embedder } from '../adapters/ollama'
import { debugLog } from '../utils/debug'

const FILE_HEAD_CHARS = 2000
const FILE_TAIL_CHARS = 1000
const MAX_SYMBOL_NAMES = 80

export interface EmbedRunOptions {
  repoRoot: string
  runId: number
  dbPath: string
  incremental?: boolean
}

export interface EmbedRunResult {
  filesEmbedded: number
  filesCarried: number
  filesFailed: number
}

export interface SemanticMatch {
  nodeId: number
  key: string
  label: string
  path: string | null
  score: number
}

interface UnitRow {
  id: number
  path: string
  language: string | null
  metadata_json: string | null
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    normA += a[i]! * a[i]!
    normB += b[i]! * b[i]!
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB)
  return denominator === 0 ? 0 : dot / denominator
}

export function vectorToBlob(vector: number[]): Uint8Array {
  return new Uint8Array(Float32Array.from(vector).buffer)
}

export function blobToVector(blob: Uint8Array): Float32Array {
  return new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4)
}

export class EmbeddingService {
  constructor(private readonly embedder: Embedder = new OllamaAdapter()) {}

  // Deterministic embedding text from structural signals only.
  private buildText(db: Database, runId: number, unit: UnitRow, repoRoot: string): string {
    const symbolNames = db.query<{ name: string }, [number, number]>(
      `SELECT DISTINCT name FROM symbols WHERE run_id=? AND node_id=? LIMIT ${MAX_SYMBOL_NAMES}`
    ).all(runId, unit.id).map(row => row.name)

    // Head + tail sampling: a single head window misrepresents long files
    // (observed: lsp.ts proc cleanup invisible behind 250 lines of parser).
    let head = ''
    let tail = ''
    try {
      const content = readFileSync(join(repoRoot, unit.path), 'utf8')
      head = content.slice(0, FILE_HEAD_CHARS)
      if (content.length > FILE_HEAD_CHARS + FILE_TAIL_CHARS) {
        tail = content.slice(-FILE_TAIL_CHARS)
      }
    } catch (err) {
      debugLog('embeddings', `failed to read ${unit.path}`, err)
    }

    const parts = [
      `path: ${unit.path}`,
      unit.language !== null ? `language: ${unit.language}` : '',
      symbolNames.length > 0 ? `symbols: ${symbolNames.join(', ')}` : '',
      head,
      tail,
    ]
    // nomic-embed-text is a retrieval model: documents and queries need their
    // task prefixes or similarity scores collapse into an undiscriminating
    // band (observed ~0.52-0.56 for everything without them).
    return 'search_document: ' + parts.filter(part => part !== '').join('\n')
  }

  async embedRun(opts: EmbedRunOptions): Promise<EmbedRunResult> {
    const db = openDb(opts.dbPath)
    const units = db.query<UnitRow, [number]>(
      `SELECT id, path, language, metadata_json FROM nodes WHERE run_id=? AND kind='unit' AND path IS NOT NULL`
    ).all(opts.runId)

    // Previous run's units + embeddings for fingerprint carry-forward.
    const previous = new Map<string, { nodeId: number; metadata_json: string | null }>()
    if (opts.incremental === true) {
      const prevRun = db.query<{ id: number }, [string, number]>(
        `SELECT id FROM runs WHERE repo_root=? AND completed_at IS NOT NULL AND id<? ORDER BY id DESC LIMIT 1`
      ).get(opts.repoRoot, opts.runId)
      if (prevRun !== null && prevRun !== undefined) {
        for (const row of db.query<{ id: number; path: string; metadata_json: string | null }, [number]>(
          `SELECT id, path, metadata_json FROM nodes WHERE run_id=? AND kind='unit'`
        ).all(prevRun.id)) {
          previous.set(row.path, { nodeId: row.id, metadata_json: row.metadata_json })
        }
      }
    }

    const insert = db.prepare(
      `INSERT INTO embeddings (run_id, node_id, model, dims, vector) VALUES (?,?,?,?,?)`
    )
    const copy = db.prepare(
      `INSERT INTO embeddings (run_id, node_id, model, dims, vector)
       SELECT ?, ?, model, dims, vector FROM embeddings WHERE node_id=? AND model=? LIMIT 1`
    )

    let filesEmbedded = 0
    let filesCarried = 0
    let filesFailed = 0

    for (const unit of units) {
      const prev = previous.get(unit.path)
      if (
        prev !== undefined &&
        unit.metadata_json !== null &&
        prev.metadata_json !== null &&
        unit.metadata_json === prev.metadata_json
      ) {
        const copied = copy.run(opts.runId, unit.id, prev.nodeId, EMBEDDING_MODEL)
        if (Number(copied.changes) > 0) {
          filesCarried++
          continue
        }
        // No prior vector to carry (e.g. first embedded run) — fall through.
      }

      const vector = await this.embedder.embed(this.buildText(db, opts.runId, unit, opts.repoRoot))
      if (vector === null) {
        filesFailed++
        continue
      }
      insert.run(opts.runId, unit.id, EMBEDDING_MODEL, vector.length, vectorToBlob(vector))
      filesEmbedded++
    }

    if (filesFailed > 0) {
      debugLog('embeddings', `${filesFailed} files failed to embed (ollama unavailable?)`)
    }
    return { filesEmbedded, filesCarried, filesFailed }
  }

  // Embed the query and rank the run's units by cosine similarity.
  async find(db: Database, runId: number, query: string, limit = 10): Promise<SemanticMatch[] | null> {
    const queryVector = await this.embedder.embed(`search_query: ${query}`)
    if (queryVector === null) return null
    return this.rank(db, runId, Float32Array.from(queryVector), limit)
  }

  // Rank units against an existing unit's vector (semantic neighbors).
  neighbors(db: Database, runId: number, nodeId: number, limit = 10): SemanticMatch[] {
    const row = db.query<{ vector: Uint8Array }, [number, number]>(
      `SELECT vector FROM embeddings WHERE run_id=? AND node_id=? LIMIT 1`
    ).get(runId, nodeId)
    if (row === null || row === undefined) return []
    return this.rank(db, runId, blobToVector(row.vector), limit + 1)
      .filter(match => match.nodeId !== nodeId)
      .slice(0, limit)
  }

  hasEmbeddings(db: Database, runId: number): boolean {
    const row = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM embeddings WHERE run_id=?`
    ).get(runId)
    return (row?.count ?? 0) > 0
  }

  private rank(db: Database, runId: number, queryVector: Float32Array, limit: number): SemanticMatch[] {
    const rows = db.query<{ node_id: number; vector: Uint8Array; key: string; label: string; path: string | null }, [number]>(
      `SELECT e.node_id, e.vector, n.key, n.label, n.path
       FROM embeddings e JOIN nodes n ON n.id = e.node_id
       WHERE e.run_id=?`
    ).all(runId)

    return rows
      .map(row => ({
        nodeId: row.node_id,
        key: row.key,
        label: row.label,
        path: row.path,
        score: cosineSimilarity(queryVector, blobToVector(row.vector)),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
  }
}
