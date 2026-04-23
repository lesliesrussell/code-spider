import { execSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import type { AnalyzerCapability, AnalyzerRegistryDocument } from '../analyzer-registry'
import { LspAdapter, type LspDiagnostic, type LspLocation, type LspSymbol } from '../adapters/lsp'
import { BuiltinLanguagePluginRegistry } from '../language-plugin-registry'
import type { LanguagePlugin, PluginAnalyzerDescriptor, PluginExecutionAttempt } from '../language-plugin'

export interface RunnerSymbolResult {
  analyzerId: number | null
  symbols: LspSymbol[]
  mode?: 'lsp' | 'heuristic'
  error?: string
}

export interface RunnerDiagnosticsResult {
  analyzerId: number | null
  diagnostics: LspDiagnostic[]
  error?: string
}

export interface RunnerReferencesResult {
  analyzerId: number | null
  locations: Array<LspLocation & { path: string }>
  error?: string
}

export interface RunnerDefinitionsResult {
  analyzerId: number | null
  locations: Array<LspLocation & { path: string }>
  error?: string
}

interface AnalyzerRunRecord {
  analyzerId: number
  nodeId: number | null
  language: string
  capability: AnalyzerCapability
  status: 'success' | 'no_result' | 'unavailable' | 'unsupported' | 'error'
  target: string
  durationMs: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}

interface RunnerArgsBase {
  db: Database
  runId: number
  nodeId: number
  filePath: string
  repoRoot: string
  language: string
  target: string
}

export interface AnalyzerRunnerOptions {
  registry?: AnalyzerRegistryDocument
  commandExists?: (bin: string) => boolean
  lspAdapter?: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences' | 'getDefinitions'>
}

function defaultCommandExists(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

export class AnalyzerRunner {
  private readonly registry: AnalyzerRegistryDocument
  private readonly commandExists: (bin: string) => boolean
  private readonly lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences' | 'getDefinitions'>
  private readonly plugins: BuiltinLanguagePluginRegistry
  private readonly analyzerRowCache = new Map<string, number>()

  constructor(options: AnalyzerRunnerOptions = {}) {
    this.registry = options.registry ?? loadDefaultAnalyzerRegistry()
    this.commandExists = options.commandExists ?? defaultCommandExists
    this.lsp = options.lspAdapter ?? new LspAdapter()
    this.plugins = new BuiltinLanguagePluginRegistry(this.registry, this.commandExists, this.lsp)
  }

  getSupportedLanguages(): string[] {
    return this.plugins.getSupportedLanguages()
  }

  registerAnalyzers(db: Database, runId: number, repoRoot: string, languages: string[]): number {
    const seen = new Set<string>()
    let inserted = 0

    for (const rawLanguage of languages) {
      const languageId = this.plugins.normalizeLanguageId(rawLanguage)
      if (languageId === undefined) continue
      if (seen.has(languageId)) continue
      seen.add(languageId)

      const plugin = this.plugins.getByLanguage(languageId)
      if (plugin === undefined) continue

      for (const analyzer of plugin.describeAnalyzers(repoRoot, languageId)) {
        const cacheKey = this.makeAnalyzerCacheKey(runId, languageId, analyzer.analyzerId)
        if (this.analyzerRowCache.has(cacheKey)) continue
        this.insertAnalyzerRow(db, runId, repoRoot, languageId, analyzer)
        inserted++
      }
    }

    return inserted
  }

  async executeSymbols(args: RunnerArgsBase): Promise<RunnerSymbolResult> {
    const languageId = this.plugins.normalizeLanguageId(args.language)
    if (languageId === undefined) {
      return { analyzerId: null, symbols: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(languageId)
    if (plugin === undefined) return { analyzerId: null, symbols: [], error: `no-plugin: ${languageId}` }
    return this.executePluginSymbols(args, languageId, plugin)
  }

  async executeDiagnostics(args: RunnerArgsBase): Promise<RunnerDiagnosticsResult> {
    const languageId = this.plugins.normalizeLanguageId(args.language)
    if (languageId === undefined) {
      return { analyzerId: null, diagnostics: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(languageId)
    if (plugin === undefined) return { analyzerId: null, diagnostics: [], error: `no-plugin: ${languageId}` }
    return this.executePluginDiagnostics(args, languageId, plugin)
  }

  async executeReferences(args: RunnerArgsBase & { position: { line: number; character: number } }): Promise<RunnerReferencesResult> {
    const languageId = this.plugins.normalizeLanguageId(args.language)
    if (languageId === undefined) {
      return { analyzerId: null, locations: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(languageId)
    if (plugin === undefined) return { analyzerId: null, locations: [], error: `no-plugin: ${languageId}` }
    return this.executePluginReferences(args, languageId, plugin)
  }

  async executeDefinitions(args: RunnerArgsBase & { symbol: string; position: { line: number; character: number } }): Promise<RunnerDefinitionsResult> {
    const languageId = this.plugins.normalizeLanguageId(args.language)
    if (languageId === undefined) {
      return { analyzerId: null, locations: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(languageId)
    if (plugin === undefined) return { analyzerId: null, locations: [], error: `no-plugin: ${languageId}` }

    const result = await plugin.getDefinitions({
      repoRoot: args.repoRoot,
      filePath: args.filePath,
      languageId,
      symbol: args.symbol,
      position: args.position,
    })
    const analyzerId = this.recordPluginAttempts(args.db, args.runId, args.nodeId, languageId, 'defs', args.target, args.repoRoot, result.attempts)
    return {
      analyzerId,
      locations: result.items.map(definition => ({
        uri: `file://${definition.path}`,
        path: definition.path,
        range: definition.range,
      })),
      error: result.error,
    }
  }

  private async executePluginSymbols(
    args: RunnerArgsBase,
    languageId: string,
    plugin: LanguagePlugin,
  ): Promise<RunnerSymbolResult> {
    const result = await plugin.getSymbols({
      repoRoot: args.repoRoot,
      filePath: args.filePath,
      languageId,
    })
    const analyzerId = this.recordPluginAttempts(args.db, args.runId, args.nodeId, languageId, 'symbols', args.target, args.repoRoot, result.attempts)
    return {
      analyzerId,
      symbols: result.items as LspSymbol[],
      mode: result.mode === 'heuristic' ? 'heuristic' : (result.mode === 'lsp' ? 'lsp' : undefined),
      error: result.error,
    }
  }

  private async executePluginDiagnostics(
    args: RunnerArgsBase,
    languageId: string,
    plugin: LanguagePlugin,
  ): Promise<RunnerDiagnosticsResult> {
    const result = await plugin.getDiagnostics({
      repoRoot: args.repoRoot,
      filePath: args.filePath,
      languageId,
    })
    const analyzerId = this.recordPluginAttempts(args.db, args.runId, args.nodeId, languageId, 'diagnostics', args.target, args.repoRoot, result.attempts)
    return { analyzerId, diagnostics: result.items as LspDiagnostic[], error: result.error }
  }

  private async executePluginReferences(
    args: RunnerArgsBase & { position: { line: number; character: number } },
    languageId: string,
    plugin: LanguagePlugin,
  ): Promise<RunnerReferencesResult> {
    const result = await plugin.getReferences({
      repoRoot: args.repoRoot,
      filePath: args.filePath,
      languageId,
      position: args.position,
    })
    const analyzerId = this.recordPluginAttempts(args.db, args.runId, args.nodeId, languageId, 'refs', args.target, args.repoRoot, result.attempts)
    return {
      analyzerId,
      locations: result.items.map(reference => ({
        uri: `file://${reference.path}`,
        path: reference.path,
        range: reference.range,
      })),
      error: result.error,
    }
  }

  private ensureAnalyzerRow(
    db: Database,
    runId: number,
    repoRoot: string,
    languageId: string,
    analyzer: PluginAnalyzerDescriptor,
  ): number {
    const cacheKey = this.makeAnalyzerCacheKey(runId, languageId, analyzer.analyzerId)
    const cached = this.analyzerRowCache.get(cacheKey)
    if (cached !== undefined) return cached
    return this.insertAnalyzerRow(db, runId, repoRoot, languageId, analyzer)
  }

  private insertAnalyzerRow(
    db: Database,
    runId: number,
    repoRoot: string,
    languageId: string,
    analyzer: PluginAnalyzerDescriptor,
  ): number {
    const cacheKey = this.makeAnalyzerCacheKey(runId, languageId, analyzer.analyzerId)
    const available = analyzer.available ? 1 : 0
    const result = db.prepare(
      'INSERT INTO analyzers (run_id, language, tool_name, tool_kind, available, metadata_json) VALUES (?,?,?,?,?,?)'
    ).run(
      runId,
      languageId,
      analyzer.tool,
      analyzer.kind,
      available,
      JSON.stringify({
        analyzerId: analyzer.analyzerId,
        capabilities: analyzer.capabilities,
        priority: analyzer.priority,
        command: analyzer.command,
        notes: analyzer.notes ?? null,
        repoRoot,
      }),
    )
    const rowId = Number(result.lastInsertRowid)
    this.analyzerRowCache.set(cacheKey, rowId)
    return rowId
  }

  private recordAnalyzerRun(db: Database, runId: number, record: AnalyzerRunRecord): void {
    db.prepare(
      `INSERT INTO analyzer_runs (
         run_id, analyzer_id, node_id, language, capability, status, target, duration_ms, error_message, metadata_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      runId,
      record.analyzerId,
      record.nodeId,
      record.language,
      record.capability,
      record.status,
      record.target,
      record.durationMs,
      record.errorMessage ?? null,
      record.metadata !== undefined ? JSON.stringify(record.metadata) : null,
    )
  }

  private recordPluginAttempts(
    db: Database,
    runId: number,
    nodeId: number,
    languageId: string,
    capability: AnalyzerCapability,
    target: string,
    repoRoot: string,
    attempts: PluginExecutionAttempt[],
  ): number | null {
    let lastAnalyzerRowId: number | null = null
    const plugin = this.plugins.getByLanguage(languageId)
    if (plugin === undefined) return null
    const analyzers = plugin.describeAnalyzers(repoRoot, languageId)

    for (const attempt of attempts) {
      const analyzer = analyzers.find(candidate => candidate.analyzerId === attempt.analyzerId)
      if (analyzer === undefined) continue
      const analyzerRowId = this.ensureAnalyzerRow(db, runId, repoRoot, languageId, analyzer)
      this.recordAnalyzerRun(db, runId, {
        analyzerId: analyzerRowId,
        nodeId,
        language: languageId,
        capability,
        status: attempt.status,
        target,
        durationMs: attempt.durationMs,
        errorMessage: attempt.errorMessage,
        metadata: attempt.metadata,
      })
      lastAnalyzerRowId = analyzerRowId
    }

    return lastAnalyzerRowId
  }

  private makeAnalyzerCacheKey(runId: number, languageId: string, analyzerId: string): string {
    return `${runId}:${languageId}:${analyzerId}`
  }
}
