import { join } from 'node:path'
import { openDb } from '../db/init'
import { AnalyzerRunner } from './analyzer-runner'
// code-spider-0pa
import { closeLspReferenceSessions } from '../adapters/lsp'
// code-spider-bik
import { debugLog } from '../utils/debug'
// code-spider-ni6
import { applyCrossLanguageReferences } from './cross-language-refs'

export interface EnrichOptions {
  repoRoot: string
  runId: number
  dbPath: string
  languages?: string[]
  maxFiles?: number
  // code-spider-oun
  // Carry forward symbols/diagnostics from the previous completed run for
  // files whose stat fingerprint (size + mtime) is unchanged; only changed
  // files pay for an analyzer session.
  incremental?: boolean
}

export interface EnrichResult {
  filesProcessed: number
  // code-spider-5rz
  // Files beyond maxFiles that were NOT enriched — surfaced so the cap is
  // never silent.
  filesSkipped: number
  // code-spider-oun: files whose results were carried from the previous run
  filesCarried: number
  symbolsAdded: number
  diagnosticsAdded: number
  // code-spider-0pi: references edges resolved between symbols
  symbolEdgesAdded: number
  analyzersRecorded: number
  errors: number
}

// code-spider-5rz
// Per-file volume caps: generated or minified files can yield tens of
// thousands of symbols/diagnostics, bloating the DB and slowing every query.
// Truncation is logged via the debug channel.
const MAX_SYMBOLS_PER_FILE = 2000
const MAX_DIAGNOSTICS_PER_FILE = 500
// code-spider-0pi code-spider-0pa
// Reference queries run against a pooled LSP session (~ms each once warm),
// so the budget is generous; the global ceiling guards pathological repos
// and the per-call fallback path, which still spawns per query.
const MAX_REF_SYMBOLS_PER_FILE = 25
const MAX_REF_QUERIES_PER_RUN = 500

export class SemanticEnricher {
  constructor(private readonly runner = new AnalyzerRunner()) {}

  async run(opts: EnrichOptions): Promise<EnrichResult> {
    const { repoRoot, runId, dbPath } = opts
    const maxFiles = opts.maxFiles ?? 100

    const db = openDb(dbPath)

    // 1. Determine which languages to process
    const langFilter = opts.languages ?? this.runner.getSupportedLanguages()

    // 2. Query unit nodes for the run
    const langPlaceholders = langFilter.map(() => '?').join(',')
    // code-spider-oun: metadata_json carries the stat fingerprint
    const unitNodes = db.query<{ id: number; path: string; language: string; metadata_json: string | null }, string[]>(
      `SELECT id, path, language, metadata_json FROM nodes WHERE run_id=? AND kind='unit' AND language IN (${langPlaceholders})`
    ).all(String(runId), ...langFilter)

    // code-spider-oun
    // Previous run's units keyed by path, for unchanged-file carry-forward.
    const previousUnits = new Map<string, { id: number; metadata_json: string | null }>()
    if (opts.incremental === true) {
      const prevRun = db.query<{ id: number }, [string, number]>(
        `SELECT id FROM runs WHERE repo_root=? AND completed_at IS NOT NULL AND id<? ORDER BY id DESC LIMIT 1`
      ).get(repoRoot, runId)
      if (prevRun !== null && prevRun !== undefined) {
        for (const row of db.query<{ id: number; path: string; metadata_json: string | null }, [number]>(
          `SELECT id, path, metadata_json FROM nodes WHERE run_id=? AND kind='unit'`
        ).all(prevRun.id)) {
          previousUnits.set(row.path, { id: row.id, metadata_json: row.metadata_json })
        }
      } else {
        debugLog('semantic-enricher', 'incremental requested but no previous completed run — full enrichment')
      }
    }

    // Cap at maxFiles
    const filesToProcess = unitNodes.slice(0, maxFiles)
    // code-spider-5rz
    const filesSkipped = unitNodes.length - filesToProcess.length
    if (filesSkipped > 0) {
      debugLog('semantic-enricher', `maxFiles cap (${maxFiles}) skipped ${filesSkipped} of ${unitNodes.length} files`)
    }
    const analyzersRecorded = this.runner.registerAnalyzers(
      db,
      runId,
      repoRoot,
      [...new Set(filesToProcess.map(node => node.language))],
    )

    // 3. Prepare insert statements
    const insertSymbol = db.prepare(
      'INSERT INTO symbols (run_id, node_id, symbol_key, name, kind, container_name, signature, range_json, selection_range_json, metadata_json) VALUES (?,?,?,?,?,?,?,?,?,?)'
    )
    const insertDiagnostic = db.prepare(
      'INSERT INTO diagnostics (run_id, node_id, analyzer_id, severity, code, message, range_json) VALUES (?,?,?,?,?,?,?)'
    )
    const insertEvidence = db.prepare(
      'INSERT INTO evidence (run_id, node_id, edge_id, kind, source, locator, snippet, score) VALUES (?,?,?,?,?,?,?,?)'
    )

    const severityMap: Record<1 | 2 | 3 | 4, string> = {
      1: 'error', 2: 'warning', 3: 'info', 4: 'hint',
    }

    let symbolsAdded = 0
    let diagnosticsAdded = 0
    let errors = 0
    // code-spider-oun
    let filesCarried = 0
    const copySymbols = db.prepare(
      `INSERT INTO symbols (run_id, node_id, symbol_key, name, kind, container_name, signature, type_info, range_json, selection_range_json, metadata_json)
       SELECT ?, ?, symbol_key, name, kind, container_name, signature, type_info, range_json, selection_range_json, metadata_json
       FROM symbols WHERE run_id != ? AND node_id = ?`
    )
    const copyDiagnostics = db.prepare(
      `INSERT INTO diagnostics (run_id, node_id, symbol_id, analyzer_id, severity, code, message, range_json, metadata_json)
       SELECT ?, ?, NULL, analyzer_id, severity, code, message, range_json, metadata_json
       FROM diagnostics WHERE run_id != ? AND node_id = ?`
    )

    for (const node of filesToProcess) {
      if (node.path === null || node.language === null) continue
      const fullPath = join(repoRoot, node.path)

      // code-spider-oun
      // Unchanged since the previous run? Carry its results instead of paying
      // for an analyzer session. Fingerprint mismatch or absence falls
      // through to full analysis — stale data can never be carried.
      const previous = previousUnits.get(node.path)
      if (
        previous !== undefined &&
        node.metadata_json !== null &&
        previous.metadata_json !== null &&
        node.metadata_json === previous.metadata_json
      ) {
        const symbolCopy = copySymbols.run(runId, node.id, runId, previous.id)
        const diagnosticCopy = copyDiagnostics.run(runId, node.id, runId, previous.id)
        symbolsAdded += Number(symbolCopy.changes)
        diagnosticsAdded += Number(diagnosticCopy.changes)
        filesCarried++
        continue
      }

      try {
        const symbolResult = await this.runner.executeSymbols({
          db,
          runId,
          nodeId: node.id,
          filePath: fullPath,
          repoRoot,
          language: node.language,
          target: node.path,
        })
        // code-spider-7be
        if (symbolResult.error !== undefined && symbolResult.errorKind !== 'no-symbols') {
          errors++
          insertEvidence.run(runId, node.id, null, 'lsp', node.path, null, symbolResult.error, 0)
        }

        // code-spider-5rz
        if (symbolResult.symbols.length > MAX_SYMBOLS_PER_FILE) {
          debugLog('semantic-enricher', `${node.path}: ${symbolResult.symbols.length} symbols truncated to ${MAX_SYMBOLS_PER_FILE}`)
        }
        for (const sym of symbolResult.symbols.slice(0, MAX_SYMBOLS_PER_FILE)) {
          const symbolKey = `${node.path}:${sym.name}`
          const metadata = {
            analyzer_id: symbolResult.analyzerId,
            mode: symbolResult.mode ?? null,
            signal: sym.signal ?? null,
          }
          insertSymbol.run(
            runId,
            node.id,
            symbolKey,
            sym.name,
            sym.kindName,
            sym.containerName ?? null,
            null,
            JSON.stringify(sym.range),
            sym.selectionRange !== undefined ? JSON.stringify(sym.selectionRange) : null,
            JSON.stringify(metadata),
          )
          symbolsAdded++
        }

        const diagnosticsResult = await this.runner.executeDiagnostics({
          db,
          runId,
          nodeId: node.id,
          filePath: fullPath,
          repoRoot,
          language: node.language,
          target: node.path,
        })
        if (diagnosticsResult.error !== undefined && diagnosticsResult.diagnostics.length === 0) {
          insertEvidence.run(runId, node.id, null, 'lsp', node.path, null, diagnosticsResult.error, 0)
        }
        if (diagnosticsResult.analyzerId !== null) {
          // code-spider-5rz
          if (diagnosticsResult.diagnostics.length > MAX_DIAGNOSTICS_PER_FILE) {
            debugLog('semantic-enricher', `${node.path}: ${diagnosticsResult.diagnostics.length} diagnostics truncated to ${MAX_DIAGNOSTICS_PER_FILE}`)
          }
          for (const diag of diagnosticsResult.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE)) {
            const severityStr = severityMap[diag.severity]
            insertDiagnostic.run(
              runId,
              node.id,
              diagnosticsResult.analyzerId,
              severityStr,
              diag.code ?? null,
              diag.message,
              JSON.stringify(diag.range),
            )
            diagnosticsAdded++
          }
        }
      } catch (err) {
        errors++
        const msg = err instanceof Error ? err.message : String(err)
        try {
          insertEvidence.run(runId, node.id, null, 'lsp', node.path, null, msg, 0)
        } catch (evidenceErr) {
          // code-spider-bik
          debugLog('semantic-enricher', `failed to record error evidence for ${node.path}`, evidenceErr)
          // best-effort
        }
      }
    }

    // code-spider-5rz code-spider-oun
    if (filesCarried > 0) {
      debugLog('semantic-enricher', `carried forward ${filesCarried} unchanged files from the previous run`)
    }

    // code-spider-0pi
    // Second pass: resolve references between symbols now that every file's
    // symbols (fresh or carried) are in the table.
    // code-spider-0pa: pooled LSP sessions stay warm for the whole pass and
    // are torn down here — leaked servers would outlive the CLI.
    let symbolEdgesAdded = 0
    try {
      symbolEdgesAdded = await this.populateSymbolEdges(db, runId, repoRoot)
    } finally {
      closeLspReferenceSessions()
    }

    // code-spider-ni6
    // Per-language servers never see across the linker boundary, so a Zig
    // `export fn` called only from C looks unreferenced. Match exported symbol
    // names across language families and record the cross-refs the unused
    // analyzers read. No LSP needed — pure DB + source scan over the symbols
    // both passes already populated.
    try {
      symbolEdgesAdded += applyCrossLanguageReferences(db, runId, repoRoot)
    } catch (err) {
      debugLog('semantic-enricher', 'cross-language reference resolution failed', err)
    }

    return { filesProcessed: filesToProcess.length, filesSkipped, filesCarried, symbolsAdded, diagnosticsAdded, symbolEdgesAdded, analyzersRecorded, errors }
  }

  // code-spider-0pi
  // For each (budgeted) symbol, ask the language plugin who references it,
  // then resolve each referencing location to its smallest enclosing symbol.
  // Edge direction: referencing symbol -> referenced symbol. Failures
  // degrade per symbol; runs without a refs-capable analyzer add nothing.
  private async populateSymbolEdges(
    db: ReturnType<typeof openDb>,
    runId: number,
    repoRoot: string
  ): Promise<number> {
    interface SymbolRow {
      id: number
      node_id: number
      path: string
      language: string
      name: string
      range_json: string | null
      selection_range_json: string | null
    }
    const rows = db
      .query<SymbolRow, [number]>(
        `SELECT s.id, s.node_id, n.path, n.language, s.name, s.range_json, s.selection_range_json
         FROM symbols s JOIN nodes n ON s.node_id = n.id
         WHERE s.run_id = ? AND n.path IS NOT NULL
         ORDER BY n.path, s.id`
      )
      .all(runId)

    interface Position {
      line: number
      character: number
    }
    interface Range {
      start: Position
      end: Position
    }
    const parseRange = (json: string | null): Range | null => {
      if (json === null) return null
      try {
        return JSON.parse(json) as Range
      } catch {
        return null
      }
    }
    const before = (a: Position, b: Position): boolean =>
      a.line < b.line || (a.line === b.line && a.character <= b.character)
    const contains = (range: Range, pos: Position): boolean => before(range.start, pos) && before(pos, range.end)
    const rangeSize = (range: Range): number => (range.end.line - range.start.line) * 10_000 + (range.end.character - range.start.character)

    const byPath = new Map<string, Array<SymbolRow & { range: Range | null }>>()
    for (const row of rows) {
      const list = byPath.get(row.path) ?? []
      list.push({ ...row, range: parseRange(row.range_json) })
      byPath.set(row.path, list)
    }

    db.query('DELETE FROM symbol_edges WHERE run_id = ?').run(runId)
    const insertEdge = db.prepare(
      'INSERT INTO symbol_edges (run_id, from_symbol_id, to_symbol_id, kind, metadata_json) VALUES (?,?,?,?,?)'
    )
    // code-spider-9cg
    // The budget means most symbols are never queried; consumers (unused-
    // export analysis) must distinguish "no references" from "never asked".
    // refQuery.externalRefs counts non-declaration locations.
    const updateMetadata = db.prepare('UPDATE symbols SET metadata_json = ? WHERE id = ?')
    const seen = new Set<string>()
    let added = 0
    let queries = 0

    for (const [path, symbols] of [...byPath.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      for (const target of symbols.slice(0, MAX_REF_SYMBOLS_PER_FILE)) {
        if (queries >= MAX_REF_QUERIES_PER_RUN) {
          debugLog('semantic-enricher', `symbol-edge budget (${MAX_REF_QUERIES_PER_RUN} queries) reached — remaining symbols skipped`)
          return added
        }
        const position = (parseRange(target.selection_range_json) ?? target.range)?.start
        if (position === undefined || position === null) continue
        queries++
        try {
          const refs = await this.runner.executeReferences({
            db,
            runId,
            nodeId: target.node_id,
            filePath: join(repoRoot, path),
            repoRoot,
            language: target.language,
            target: path,
            position,
          })
          // code-spider-9cg
          let externalRefs = 0
          for (const location of refs.locations) {
            // Locations come back absolute; the symbol table is keyed by
            // repo-relative paths.
            const relPath = location.path.startsWith(`${repoRoot}/`)
              ? location.path.slice(repoRoot.length + 1)
              : location.path
            // code-spider-9cg: the declaration itself (the queried position)
            // is not a use.
            const isDeclaration =
              relPath === path &&
              location.range.start.line === position.line &&
              location.range.start.character === position.character
            if (!isDeclaration) externalRefs++
            const candidates = byPath.get(relPath) ?? []
            let enclosing: (SymbolRow & { range: Range | null }) | undefined
            for (const candidate of candidates) {
              if (candidate.range === null || !contains(candidate.range, location.range.start)) continue
              if (enclosing === undefined || rangeSize(candidate.range) < rangeSize(enclosing.range!)) {
                enclosing = candidate
              }
            }
            if (enclosing === undefined || enclosing.id === target.id) continue
            const key = `${enclosing.id}>${target.id}`
            if (seen.has(key)) continue
            seen.add(key)
            insertEdge.run(runId, enclosing.id, target.id, 'references', JSON.stringify({ analyzer_id: refs.analyzerId }))
            added++
          }
          // code-spider-9cg: stamp the query outcome onto the symbol.
          if (refs.analyzerId !== null) {
            const row = db.query<{ metadata_json: string | null }, [number]>('SELECT metadata_json FROM symbols WHERE id = ?').get(target.id)
            let metadata: Record<string, unknown> = {}
            try {
              metadata = row?.metadata_json !== null && row?.metadata_json !== undefined ? (JSON.parse(row.metadata_json) as Record<string, unknown>) : {}
            } catch {
              metadata = {}
            }
            metadata['refQuery'] = { externalRefs }
            updateMetadata.run(JSON.stringify(metadata), target.id)
          }
        } catch (err) {
          debugLog('semantic-enricher', `reference resolution failed for ${path}:${target.name}`, err)
        }
      }
    }
    return added
  }
}
