import type { Database } from 'bun:sqlite'

export interface DefinitionMatch {
  symbolId: number
  nodeId: number
  nodeKey: string
  path: string | null
  language: string | null
  name: string
  kind: string
  containerName: string | null
  signature: string | null
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
  anchorLine: number | null
  anchorColumn: number | null
  heuristic: boolean
}

export interface ReferenceMatch {
  path: string
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
}

export interface AtomMatch {
  symbolId: number
  nodeId: number
  nodeKey: string
  path: string | null
  language: string | null
  name: string
  kind: string
  containerName: string | null
  signature: string | null
  line: number | null
  column: number | null
  endLine: number | null
  endColumn: number | null
  anchorLine: number | null
  anchorColumn: number | null
  heuristic: boolean
}

interface DefinitionRow {
  symbol_id: number
  node_id: number
  node_key: string
  path: string | null
  language: string | null
  name: string
  kind: string
  container_name: string | null
  signature: string | null
  range_json: string | null
  selection_range_json: string | null
  metadata_json: string | null
}

interface RangeShape {
  start?: { line?: number; character?: number }
  end?: { line?: number; character?: number }
}

function parseRange(rangeJson: string | null): RangeShape | null {
  if (!rangeJson) return null
  try {
    return JSON.parse(rangeJson) as RangeShape
  } catch {
    return null
  }
}

function isHeuristic(metadataJson: string | null): boolean {
  if (!metadataJson) return false
  try {
    const metadata = JSON.parse(metadataJson) as { mode?: string }
    return metadata.mode === 'heuristic'
  } catch {
    return false
  }
}

export class SemanticQueryService {
  constructor(private readonly db: Database, private readonly runId: number) {}

  findDefinitions(symbolQuery: string): DefinitionMatch[] {
    const rows = this.db.query<DefinitionRow, [number, string]>(
      `SELECT
         s.id AS symbol_id,
         s.node_id,
         n.key AS node_key,
         n.path,
         n.language,
         s.name,
         s.kind,
         s.container_name,
         s.signature,
         s.range_json,
         s.selection_range_json,
         s.metadata_json
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id = ?
         AND LOWER(s.name) = LOWER(?)
      ORDER BY
        CASE WHEN s.metadata_json LIKE '%"mode":"heuristic"%' THEN 1 ELSE 0 END,
        n.path ASC,
         s.name ASC`
    ).all(this.runId, symbolQuery)

    return rows.map(row => {
      const range = parseRange(row.range_json)
      const selectionRange = parseRange(row.selection_range_json)
      return {
        symbolId: row.symbol_id,
        nodeId: row.node_id,
        nodeKey: row.node_key,
        path: row.path,
        language: row.language,
        name: row.name,
        kind: row.kind,
        containerName: row.container_name,
        signature: row.signature,
        line: range?.start?.line ?? null,
        column: range?.start?.character ?? null,
        endLine: range?.end?.line ?? null,
        endColumn: range?.end?.character ?? null,
        anchorLine: selectionRange?.start?.line ?? range?.start?.line ?? null,
        anchorColumn: selectionRange?.start?.character ?? range?.start?.character ?? null,
        heuristic: isHeuristic(row.metadata_json),
      }
    })
  }

  findIndexedReferences(symbolQuery: string): ReferenceMatch[] {
    const rows = this.db.query<{ path: string | null; range_json: string | null }, [number, string]>(
      `SELECT n.path, s.range_json
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id = ?
         AND LOWER(s.name) = LOWER(?)
       ORDER BY n.path ASC`
    ).all(this.runId, symbolQuery)

    return rows.flatMap(row => {
      if (row.path === null) return []
      const range = parseRange(row.range_json)
      return [{
        path: row.path,
        line: range?.start?.line ?? null,
        column: range?.start?.character ?? null,
        endLine: range?.end?.line ?? null,
        endColumn: range?.end?.character ?? null,
      }]
    })
  }

  findAtoms(unitRef: string): AtomMatch[] {
    const rows = this.db.query<DefinitionRow, [number, string]>(
      `SELECT
         s.id AS symbol_id,
         s.node_id,
         n.key AS node_key,
         n.path,
         n.language,
         s.name,
         s.kind,
         s.container_name,
         s.signature,
         s.range_json,
         s.selection_range_json,
         s.metadata_json
       FROM symbols s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id = ?
         AND n.key = ?
       ORDER BY
         COALESCE(json_extract(s.selection_range_json, '$.start.line'), json_extract(s.range_json, '$.start.line'), 999999),
         COALESCE(json_extract(s.selection_range_json, '$.start.character'), json_extract(s.range_json, '$.start.character'), 999999),
         s.name ASC,
         s.kind ASC`
    ).all(this.runId, unitRef)

    return rows.map(row => {
      const range = parseRange(row.range_json)
      const selectionRange = parseRange(row.selection_range_json)
      return {
        symbolId: row.symbol_id,
        nodeId: row.node_id,
        nodeKey: row.node_key,
        path: row.path,
        language: row.language,
        name: row.name,
        kind: row.kind,
        containerName: row.container_name,
        signature: row.signature,
        line: range?.start?.line ?? null,
        column: range?.start?.character ?? null,
        endLine: range?.end?.line ?? null,
        endColumn: range?.end?.character ?? null,
        anchorLine: selectionRange?.start?.line ?? range?.start?.line ?? null,
        anchorColumn: selectionRange?.start?.character ?? range?.start?.character ?? null,
        heuristic: isHeuristic(row.metadata_json),
      }
    })
  }
}
