import { join } from 'node:path'
import { openDb } from '../db/init'
import { AnalyzerRunner } from './analyzer-runner'
// code-spider-bik
import { debugLog } from '../utils/debug'

export interface EnrichOptions {
  repoRoot: string
  runId: number
  dbPath: string
  languages?: string[]
  maxFiles?: number
}

export interface EnrichResult {
  filesProcessed: number
  // code-spider-5rz
  // Files beyond maxFiles that were NOT enriched — surfaced so the cap is
  // never silent.
  filesSkipped: number
  symbolsAdded: number
  diagnosticsAdded: number
  analyzersRecorded: number
  errors: number
}

// code-spider-5rz
// Per-file volume caps: generated or minified files can yield tens of
// thousands of symbols/diagnostics, bloating the DB and slowing every query.
// Truncation is logged via the debug channel.
const MAX_SYMBOLS_PER_FILE = 2000
const MAX_DIAGNOSTICS_PER_FILE = 500

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
    const unitNodes = db.query<{ id: number; path: string; language: string }, string[]>(
      `SELECT id, path, language FROM nodes WHERE run_id=? AND kind='unit' AND language IN (${langPlaceholders})`
    ).all(String(runId), ...langFilter)

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

    for (const node of filesToProcess) {
      if (node.path === null || node.language === null) continue
      const fullPath = join(repoRoot, node.path)

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

    // code-spider-5rz
    return { filesProcessed: filesToProcess.length, filesSkipped, symbolsAdded, diagnosticsAdded, analyzersRecorded, errors }
  }
}
