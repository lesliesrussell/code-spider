// code-spider-ni6
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { debugLog } from '../utils/debug'

// Cross-language reference resolution. The per-language enrichers (clangd for
// C/C++, zls for Zig) never see across the linker boundary, so a Zig
// `export fn foo` called only from C looks like it has zero references and the
// unused analyzer flags it. This pass matches EXPORTED symbol names across
// language families (Zig `export fn`/`export var` <-> C `extern` decl /
// linker symbol, Rust `#[no_mangle]`/`extern "C"`, etc.) and records the
// cross-refs the unused analyzers read, so the export counts as referenced.

export interface CrossLangSymbolInput {
  id: number
  name: string
  // nodes.language display value: 'Zig', 'C/C++', 'Rust', ...
  language: string
  kindName: string
  // source text of the declaration line (export marker lives here for Zig/C)
  declLine: string
  // small window of lines above the declaration (Rust attributes sit there)
  precedingLines?: string[]
  // current refQuery.externalRefs; null when the symbol was never queried
  externalRefs: number | null
}

export interface CrossLangEdge {
  from: number
  to: number
}

export interface CrossLangResolution {
  symbolId: number
  externalRefs: number
  edges: CrossLangEdge[]
}

export function resolveCrossLanguageReferences(symbols: CrossLangSymbolInput[]): CrossLangResolution[] {
  const byName = new Map<string, CrossLangSymbolInput[]>()
  for (const sym of symbols) {
    const list = byName.get(sym.name) ?? []
    list.push(sym)
    byName.set(sym.name, list)
  }

  const resolutions: CrossLangResolution[] = []
  for (const group of byName.values()) {
    // Only act on a name shared by ABI participants in >1 language family, and
    // only when at least one of them actually defines the symbol (an export).
    // The export gate keeps two unrelated declarations that merely collide on a
    // name from suppressing each other.
    const participants = group.filter(isAbiParticipant)
    const families = new Set(participants.map(s => family(s.language)))
    if (families.size < 2 || !participants.some(isAbiExport)) continue

    for (const sym of participants) {
      // foreign = the same ABI symbol as seen from other languages: each one
      // references `sym` across the linker boundary.
      const foreign = participants.filter(other => family(other.language) !== family(sym.language))
      if (foreign.length === 0) continue
      const edges = foreign.map(f => ({ from: f.id, to: sym.id }))
      const externalRefs = Math.max(sym.externalRefs ?? 0, foreign.length)
      resolutions.push({ symbolId: sym.id, externalRefs, edges })
    }
  }
  return resolutions
}

// A bare prototype / forward declaration ends in `;` with no body and no
// initializer; a definition has a `{` body or an `=` initializer.
function isForwardDeclaration(declLine: string): boolean {
  const trimmed = declLine.trim()
  return trimmed.endsWith(';') && !trimmed.includes('{') && !trimmed.includes('=')
}

export const CROSS_LANGUAGE_EDGE_KIND = 'cross-language-references'

// How many lines above a declaration to scan for an export marker (Rust's
// `#[no_mangle]` attribute typically sits on the preceding line).
const PRECEDING_WINDOW = 3

interface DbSymbolRow {
  id: number
  name: string
  language: string
  kind: string
  path: string
  range_json: string | null
  selection_range_json: string | null
  metadata_json: string | null
}

// Reads the per-language enriched symbols, resolves cross-language ABI
// references, and writes them where the unused analyzers look: an edge into
// symbol_edges plus a bumped refQuery.externalRefs on the export symbol.
// Runs after populateSymbolEdges, so it must not clear existing edges.
export function applyCrossLanguageReferences(db: Database, runId: number, repoRoot: string): number {
  const rows = db
    .query<DbSymbolRow, [number]>(
      `SELECT s.id, s.name, n.language, s.kind, n.path, s.range_json, s.selection_range_json, s.metadata_json
       FROM symbols s JOIN nodes n ON s.node_id = n.id
       WHERE s.run_id = ? AND n.path IS NOT NULL AND n.language IS NOT NULL`
    )
    .all(runId)

  const sourceCache = new Map<string, string[] | null>()
  const readLines = (path: string): string[] | null => {
    if (sourceCache.has(path)) return sourceCache.get(path)!
    let lines: string[] | null = null
    try {
      lines = readFileSync(join(repoRoot, path), 'utf8').split('\n')
    } catch (err) {
      debugLog('cross-language-refs', `cannot read ${path}`, err)
    }
    sourceCache.set(path, lines)
    return lines
  }

  const inputs: CrossLangSymbolInput[] = []
  for (const row of rows) {
    const startLine = declarationLine(row)
    const lines = readLines(row.path)
    const declLine = startLine !== null ? (lines?.[startLine] ?? '') : ''
    const precedingLines = startLine !== null && lines !== null ? lines.slice(Math.max(0, startLine - PRECEDING_WINDOW), startLine) : []
    inputs.push({
      id: row.id,
      name: row.name,
      language: row.language,
      kindName: row.kind,
      declLine,
      precedingLines,
      externalRefs: parseExternalRefs(row.metadata_json),
    })
  }

  const resolutions = resolveCrossLanguageReferences(inputs)
  if (resolutions.length === 0) return 0

  const insertEdge = db.prepare('INSERT INTO symbol_edges (run_id, from_symbol_id, to_symbol_id, kind, metadata_json) VALUES (?,?,?,?,?)')
  const updateMetadata = db.prepare('UPDATE symbols SET metadata_json = ? WHERE id = ?')
  const metaById = new Map(rows.map(r => [r.id, r.metadata_json]))
  const seen = new Set<string>()
  let added = 0

  for (const res of resolutions) {
    for (const edge of res.edges) {
      const key = `${edge.from}>${edge.to}`
      if (seen.has(key)) continue
      seen.add(key)
      insertEdge.run(runId, edge.from, edge.to, CROSS_LANGUAGE_EDGE_KIND, JSON.stringify({ via: 'c-abi' }))
      added++
    }
    let metadata: Record<string, unknown> = {}
    const raw = metaById.get(res.symbolId)
    try {
      metadata = raw !== null && raw !== undefined ? (JSON.parse(raw) as Record<string, unknown>) : {}
    } catch {
      metadata = {}
    }
    metadata['refQuery'] = { externalRefs: res.externalRefs }
    updateMetadata.run(JSON.stringify(metadata), res.symbolId)
  }
  return added
}

function parseExternalRefs(metadataJson: string | null): number | null {
  if (metadataJson === null) return null
  try {
    const metadata = JSON.parse(metadataJson) as { refQuery?: { externalRefs?: unknown } }
    const value = metadata.refQuery?.externalRefs
    return typeof value === 'number' ? value : null
  } catch {
    return null
  }
}

function declarationLine(row: { selection_range_json: string | null; range_json: string | null }): number | null {
  for (const json of [row.selection_range_json, row.range_json]) {
    if (json === null) continue
    try {
      const range = JSON.parse(json) as { start?: { line?: number } }
      if (typeof range.start?.line === 'number') return range.start.line
    } catch {
      // fall through
    }
  }
  return null
}

function family(language: string): string {
  switch (language) {
    case 'C/C++':
      return 'c'
    case 'Zig':
      return 'zig'
    case 'Rust':
      return 'rust'
    default:
      return language.toLowerCase()
  }
}

// Only function/variable-like symbols cross the C ABI; never link a struct or
// enum that merely shares a name with a foreign function.
const ABI_KINDS = new Set(['Function', 'Method', 'Variable', 'Constant'])

function isAbiExport(sym: CrossLangSymbolInput): boolean {
  if (!ABI_KINDS.has(sym.kindName)) return false
  switch (family(sym.language)) {
    case 'zig':
      // `export fn foo` / `export var foo` — the keyword sits on the decl line.
      return /\bexport\b/.test(sym.declLine)
    case 'rust':
      // `#[no_mangle]` (usually the line above) and/or `extern "C"`.
      return /\bextern\s+"C"/.test(sym.declLine) || (sym.precedingLines ?? []).some(l => /#\[\s*no_mangle\s*\]/.test(l))
    case 'c':
      // C globals have external linkage unless declared `static`. Only the
      // *definition* can be falsely "unused"; a forward declaration / prototype
      // (`void f(void);`) is itself a reference vector, so exclude it.
      return !/\bstatic\b/.test(sym.declLine) && !isForwardDeclaration(sym.declLine)
    default:
      return false
  }
}

// An ABI participant is either the export (definition) or an external
// declaration of the same linker symbol in another language — e.g. the C
// header prototype paired with a Zig `export fn`, or a Zig `extern fn` paired
// with a C definition. Both are part of the boundary and neither is dead when
// the other side defines the symbol.
function isAbiParticipant(sym: CrossLangSymbolInput): boolean {
  if (!ABI_KINDS.has(sym.kindName)) return false
  if (isAbiExport(sym)) return true
  switch (family(sym.language)) {
    case 'c':
      // Any externally-linked C declaration (prototype or definition).
      return !/\bstatic\b/.test(sym.declLine)
    case 'zig':
      // `extern fn foo` / `extern var foo` imports a C-defined symbol.
      return /\bextern\b/.test(sym.declLine)
    default:
      return false
  }
}
