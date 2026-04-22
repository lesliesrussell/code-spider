import { execSync, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import type {
  AnalyzerCapability,
  AnalyzerRegistryDocument,
  RegistryAnalyzer,
  RegistryLanguage,
} from '../analyzer-registry'
import { LspAdapter, type LspDiagnostic, type LspLocation, type LspSymbol } from '../adapters/lsp'
import { BuiltinLanguagePluginRegistry } from '../language-plugin-registry'
import type { LanguagePlugin, PluginExecutionAttempt } from '../language-plugin'
import { heuristicSymbols } from '../plugins/shared/heuristic-symbols'

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

interface ResolvedAnalyzer {
  language: RegistryLanguage
  analyzer: RegistryAnalyzer
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

interface QualityExecutionResult {
  diagnostics: LspDiagnostic[]
  error?: string
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
  lspAdapter?: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences'>
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
  private readonly lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences'>
  private readonly plugins: BuiltinLanguagePluginRegistry
  private readonly analyzerRowCache = new Map<string, number>()

  constructor(options: AnalyzerRunnerOptions = {}) {
    this.registry = options.registry ?? loadDefaultAnalyzerRegistry()
    this.commandExists = options.commandExists ?? defaultCommandExists
    this.lsp = options.lspAdapter ?? new LspAdapter()
    this.plugins = new BuiltinLanguagePluginRegistry(this.registry, this.commandExists, this.lsp)
  }

  getSupportedLanguages(): string[] {
    return this.registry.languages.flatMap(language => [
      language.id,
      language.display_name,
      ...(language.aliases ?? []),
    ])
  }

  registerAnalyzers(db: Database, runId: number, repoRoot: string, languages: string[]): number {
    const seen = new Set<string>()
    let inserted = 0

    for (const rawLanguage of languages) {
      const language = this.findLanguage(rawLanguage)
      if (language === undefined) continue
      if (seen.has(language.id)) continue
      seen.add(language.id)

      for (const analyzer of language.analyzers) {
        const cacheKey = this.makeAnalyzerCacheKey(runId, language.id, analyzer.id)
        if (this.analyzerRowCache.has(cacheKey)) continue
        this.insertAnalyzerRow(db, runId, repoRoot, language, analyzer)
        inserted++
      }
    }

    return inserted
  }

  async executeSymbols(args: RunnerArgsBase): Promise<RunnerSymbolResult> {
    const language = this.findLanguage(args.language)
    if (language === undefined) {
      return { analyzerId: null, symbols: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(language.id)
    if (plugin !== undefined) return this.executePluginSymbols(args, language.id, plugin)
    return this.executeSymbolsLegacy(args, language)
  }

  async executeDiagnostics(args: RunnerArgsBase): Promise<RunnerDiagnosticsResult> {
    const language = this.findLanguage(args.language)
    if (language === undefined) {
      return { analyzerId: null, diagnostics: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(language.id)
    if (plugin !== undefined) return this.executePluginDiagnostics(args, language.id, plugin)
    return this.executeDiagnosticsLegacy(args, language)
  }

  async executeReferences(args: RunnerArgsBase & { position: { line: number; character: number } }): Promise<RunnerReferencesResult> {
    const language = this.findLanguage(args.language)
    if (language === undefined) {
      return { analyzerId: null, locations: [], error: `unsupported-language: ${args.language}` }
    }

    const plugin = this.plugins.getByLanguage(language.id)
    if (plugin !== undefined) return this.executePluginReferences(args, language.id, plugin)
    return this.executeReferencesLegacy(args, language)
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

  private async executeSymbolsLegacy(args: RunnerArgsBase, language: RegistryLanguage): Promise<RunnerSymbolResult> {
    const candidates = this.getCandidates(args.repoRoot, language, 'symbols')
    if (candidates.length === 0) {
      return { analyzerId: null, symbols: [], error: `no-analyzer: ${language.id}` }
    }

    for (const candidate of candidates) {
      const analyzerRowId = this.ensureAnalyzerRow(args.db, args.runId, args.repoRoot, candidate)
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'symbols',
          status: 'unavailable',
          target: args.target,
          durationMs: 0,
          errorMessage: `tool not found: ${bin}`,
        })
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getSymbols(
            args.filePath,
            language.id,
            args.repoRoot,
            candidate.analyzer.command,
            false,
          )
          const durationMs = Date.now() - started
          const status = result.symbols.length > 0 ? 'success' : 'no_result'
          this.recordAnalyzerRun(args.db, args.runId, {
            analyzerId: analyzerRowId,
            nodeId: args.nodeId,
            language: language.id,
            capability: 'symbols',
            status,
            target: args.target,
            durationMs,
            errorMessage: result.error,
            metadata: { symbolCount: result.symbols.length, kind: candidate.analyzer.kind },
          })
          if (result.symbols.length > 0) {
            return { analyzerId: analyzerRowId, symbols: result.symbols, mode: 'lsp', error: result.error }
          }
          continue
        }

        if (candidate.analyzer.kind === 'heuristic') {
          const symbols = heuristicSymbols(readFileSync(args.filePath, 'utf8'))
          const durationMs = Date.now() - started
          const status = symbols.length > 0 ? 'success' : 'no_result'
          this.recordAnalyzerRun(args.db, args.runId, {
            analyzerId: analyzerRowId,
            nodeId: args.nodeId,
            language: language.id,
            capability: 'symbols',
            status,
            target: args.target,
            durationMs,
            metadata: { symbolCount: symbols.length, kind: candidate.analyzer.kind, mode: 'heuristic' },
          })
          if (symbols.length > 0) {
            return { analyzerId: analyzerRowId, symbols, mode: 'heuristic' }
          }
          continue
        }

        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'symbols',
          status: 'unsupported',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: `unsupported analyzer kind for symbols: ${candidate.analyzer.kind}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'symbols',
          status: 'error',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: message,
        })
      }
    }

    return { analyzerId: null, symbols: [], error: `no-symbols: ${args.target}` }
  }

  private async executeDiagnosticsLegacy(args: RunnerArgsBase, language: RegistryLanguage): Promise<RunnerDiagnosticsResult> {
    const candidates = this.getCandidates(args.repoRoot, language, 'diagnostics')
    if (candidates.length === 0) {
      return { analyzerId: null, diagnostics: [], error: `no-analyzer: ${language.id}` }
    }

    for (const candidate of candidates) {
      const analyzerRowId = this.ensureAnalyzerRow(args.db, args.runId, args.repoRoot, candidate)
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'diagnostics',
          status: 'unavailable',
          target: args.target,
          durationMs: 0,
          errorMessage: `tool not found: ${bin}`,
        })
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getDiagnostics(
            args.filePath,
            language.id,
            args.repoRoot,
            candidate.analyzer.command,
          )
          const durationMs = Date.now() - started
          this.recordAnalyzerRun(args.db, args.runId, {
            analyzerId: analyzerRowId,
            nodeId: args.nodeId,
            language: language.id,
            capability: 'diagnostics',
            status: result.error === undefined ? 'success' : 'no_result',
            target: args.target,
            durationMs,
            errorMessage: result.error,
            metadata: { diagnosticCount: result.diagnostics.length, kind: candidate.analyzer.kind },
          })
          if (result.error === undefined) {
            return { analyzerId: analyzerRowId, diagnostics: result.diagnostics }
          }
          continue
        }

        if (candidate.analyzer.kind === 'quality') {
          const result = this.executeQualityAnalyzer(candidate.analyzer, args.filePath, args.repoRoot, language.id)
          const durationMs = Date.now() - started
          this.recordAnalyzerRun(args.db, args.runId, {
            analyzerId: analyzerRowId,
            nodeId: args.nodeId,
            language: language.id,
            capability: 'diagnostics',
            status: 'success',
            target: args.target,
            durationMs,
            metadata: {
              diagnosticCount: result.diagnostics.length,
              kind: candidate.analyzer.kind,
              exitError: result.error ?? null,
            },
          })
          return { analyzerId: analyzerRowId, diagnostics: result.diagnostics, error: result.error }
        }

        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'diagnostics',
          status: 'unsupported',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: `diagnostics execution not implemented for analyzer kind ${candidate.analyzer.kind}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'diagnostics',
          status: 'error',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: message,
        })
      }
    }

    return { analyzerId: null, diagnostics: [], error: `no-diagnostics: ${args.target}` }
  }

  private async executeReferencesLegacy(
    args: RunnerArgsBase & { position: { line: number; character: number } },
    language: RegistryLanguage,
  ): Promise<RunnerReferencesResult> {
    const candidates = this.getCandidates(args.repoRoot, language, 'refs')
    if (candidates.length === 0) {
      return { analyzerId: null, locations: [], error: `no-analyzer: ${language.id}` }
    }

    for (const candidate of candidates) {
      const analyzerRowId = this.ensureAnalyzerRow(args.db, args.runId, args.repoRoot, candidate)
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'refs',
          status: 'unavailable',
          target: args.target,
          durationMs: 0,
          errorMessage: `tool not found: ${bin}`,
        })
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getReferences(
            args.filePath,
            language.id,
            args.position,
            args.repoRoot,
            candidate.analyzer.command,
          )
          const durationMs = Date.now() - started
          const status = result.locations.length > 0 ? 'success' : 'no_result'
          this.recordAnalyzerRun(args.db, args.runId, {
            analyzerId: analyzerRowId,
            nodeId: args.nodeId,
            language: language.id,
            capability: 'refs',
            status,
            target: args.target,
            durationMs,
            errorMessage: result.error,
            metadata: { referenceCount: result.locations.length, kind: candidate.analyzer.kind },
          })
          if (result.locations.length > 0) {
            return { analyzerId: analyzerRowId, locations: result.locations, error: result.error }
          }
          continue
        }

        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'refs',
          status: 'unsupported',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: `reference execution not implemented for analyzer kind ${candidate.analyzer.kind}`,
        })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        this.recordAnalyzerRun(args.db, args.runId, {
          analyzerId: analyzerRowId,
          nodeId: args.nodeId,
          language: language.id,
          capability: 'refs',
          status: 'error',
          target: args.target,
          durationMs: Date.now() - started,
          errorMessage: message,
        })
      }
    }

    return { analyzerId: null, locations: [], error: `no-references: ${args.target}` }
  }

  private executeQualityAnalyzer(
    analyzer: RegistryAnalyzer,
    filePath: string,
    repoRoot: string,
    languageId: string,
  ): QualityExecutionResult {
    const command = analyzer.command.map(arg => (
      arg
        .replaceAll('{file}', filePath)
        .replaceAll('{repo_root}', repoRoot)
        .replaceAll('{language}', languageId)
    ))
    const [bin, ...args] = command
    if (bin === undefined) {
      return { diagnostics: [], error: 'missing-command' }
    }

    const result = spawnSync(bin, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 10000,
    })

    if (result.error) {
      return { diagnostics: [], error: result.error.message }
    }

    const stderr = (result.stderr ?? '').trim()
    const stdout = (result.stdout ?? '').trim()
    const text = [stderr, stdout].filter(Boolean).join('\n').trim()
    if (result.status === 0) {
      return { diagnostics: [] }
    }

    const message = text === '' ? `${analyzer.tool} exited with status ${String(result.status)}` : text
    return {
      diagnostics: [{
        severity: 1,
        message,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      }],
      error: message,
    }
  }

  private findLanguage(query: string): RegistryLanguage | undefined {
    const normalized = query.toLowerCase()
    return this.registry.languages.find(language =>
      language.id === normalized ||
      language.display_name.toLowerCase() === normalized ||
      (language.aliases ?? []).some(alias => alias.toLowerCase() === normalized)
    )
  }

  private getCandidates(repoRoot: string, language: RegistryLanguage, capability: AnalyzerCapability): ResolvedAnalyzer[] {
    return language.analyzers
      .filter(analyzer => analyzer.capabilities.includes(capability))
      .filter(analyzer => this.isAnalyzerEligible(analyzer, repoRoot))
      .map(analyzer => ({ language, analyzer }))
      .sort((a, b) => b.analyzer.priority - a.analyzer.priority)
  }

  private isAnalyzerEligible(analyzer: RegistryAnalyzer, repoRoot: string): boolean {
    if ((analyzer.required_files ?? []).length === 0) return true
    return analyzer.required_files?.every(file => existsSync(`${repoRoot}/${file}`)) ?? true
  }

  private ensureAnalyzerRow(db: Database, runId: number, repoRoot: string, resolved: ResolvedAnalyzer): number {
    const cacheKey = this.makeAnalyzerCacheKey(runId, resolved.language.id, resolved.analyzer.id)
    const cached = this.analyzerRowCache.get(cacheKey)
    if (cached !== undefined) return cached
    return this.insertAnalyzerRow(db, runId, repoRoot, resolved.language, resolved.analyzer)
  }

  private insertAnalyzerRow(
    db: Database,
    runId: number,
    repoRoot: string,
    language: RegistryLanguage,
    analyzer: RegistryAnalyzer,
  ): number {
    const cacheKey = this.makeAnalyzerCacheKey(runId, language.id, analyzer.id)
    const available = analyzer.kind === 'heuristic'
      ? 1
      : (this.commandExists(analyzer.command[0] ?? '') ? 1 : 0)
    const result = db.prepare(
      'INSERT INTO analyzers (run_id, language, tool_name, tool_kind, available, metadata_json) VALUES (?,?,?,?,?,?)'
    ).run(
      runId,
      language.id,
      analyzer.tool,
      analyzer.kind,
      available,
      JSON.stringify({
        analyzerId: analyzer.id,
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
    const language = this.findLanguage(languageId)
    if (language === undefined) return null

    for (const attempt of attempts) {
      const analyzer = language.analyzers.find(candidate => candidate.id === attempt.analyzerId)
      if (analyzer === undefined) continue
      const analyzerRowId = this.ensureAnalyzerRow(db, runId, repoRoot, { language, analyzer })
      this.recordAnalyzerRun(db, runId, {
        analyzerId: analyzerRowId,
        nodeId,
        language: language.id,
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
