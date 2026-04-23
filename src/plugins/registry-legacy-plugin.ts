import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { AnalyzerRegistryDocument, RegistryAnalyzer, RegistryLanguage } from '../analyzer-registry'
import type {
  DefinitionsQuery,
  LanguagePlugin,
  PluginCapabilityStatus,
  PluginContext,
  PluginAnalyzerDescriptor,
  PluginDefinition,
  PluginDetectionResult,
  PluginDiagnostic,
  PluginExecutionAttempt,
  PluginHealth,
  PluginReference,
  PluginResult,
  PluginSymbol,
  ReferencesQuery,
} from '../language-plugin'
import { collectWorkspaceFiles, LspAdapter } from '../adapters/lsp'
import { heuristicSymbols } from './shared/heuristic-symbols'

type Capability = 'symbols' | 'diagnostics' | 'references' | 'definitions'

interface ResolvedAnalyzer {
  language: RegistryLanguage
  analyzer: RegistryAnalyzer
}

export class RegistryLegacyPlugin implements LanguagePlugin {
  readonly id = 'builtin.registry-legacy'
  readonly displayName = 'Built-in Registry Legacy Plugin'
  readonly languageIds: string[] = []
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'health'] as const

  constructor(
    private readonly registry: AnalyzerRegistryDocument,
    private readonly commandExists: (bin: string) => boolean,
    private readonly lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences' | 'getDefinitions'> = new LspAdapter(),
    private readonly excludedLanguageIds = new Set<string>(),
  ) {}

  detect(repoRoot: string, filePath: string): PluginDetectionResult {
    const language = this.findLanguageFromPath(filePath)
    if (language === undefined) return { supported: false, confidence: 0 }
    const candidates = ['symbols', 'diagnostics', 'references'].flatMap(capability =>
      this.getCandidates(repoRoot, language.id, capability as Capability),
    )
    return {
      supported: true,
      confidence: candidates.length > 0 ? 0.8 : 0.5,
      languageId: language.id,
      reason: candidates.length > 0 ? undefined : 'no configured analyzers matched',
    }
  }

  health(repoRoot: string): PluginHealth {
    const candidates = this.registry.languages
      .filter(language => !this.excludedLanguageIds.has(language.id))
      .flatMap(language => ['symbols', 'diagnostics', 'references'].flatMap(capability =>
        this.getCandidates(repoRoot, language.id, capability as Capability),
      ))
    const available = candidates.some(candidate =>
      candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
    )
    return {
      available,
      toolName: 'registry-defined analyzers',
      details: available ? undefined : 'No registry-based semantic providers available',
    }
  }

  capabilityStatus(repoRoot: string): Record<'symbols' | 'definitions' | 'references' | 'diagnostics' | 'health', PluginCapabilityStatus> {
    const supports = (capability: Capability): PluginCapabilityStatus => {
      const candidates = this.registry.languages
        .filter(language => !this.excludedLanguageIds.has(language.id))
        .flatMap(language => this.getCandidates(repoRoot, language.id, capability))
      const available = candidates.some(candidate =>
        candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
      )
      return { supported: candidates.length > 0, available }
    }

    return {
      symbols: supports('symbols'),
      definitions: supports('definitions'),
      references: supports('references'),
      diagnostics: supports('diagnostics'),
      health: { supported: true, available: true },
    }
  }

  describeAnalyzers(repoRoot: string, languageId: string): PluginAnalyzerDescriptor[] {
    const language = this.requireLanguage(languageId)
    if (language === undefined) return []

    return language.analyzers
      .filter(analyzer => this.isAnalyzerEligible(analyzer, repoRoot))
      .sort((a, b) => b.priority - a.priority)
      .map(analyzer => ({
        analyzerId: analyzer.id,
        kind: analyzer.kind,
        tool: analyzer.tool,
        command: analyzer.command,
        capabilities: analyzer.capabilities,
        priority: analyzer.priority,
        available: analyzer.kind === 'heuristic' || this.commandExists(analyzer.command[0] ?? ''),
        notes: analyzer.notes,
      }))
  }

  async getSymbols(ctx: PluginContext): Promise<PluginResult<PluginSymbol>> {
    const language = this.requireLanguage(ctx.languageId)
    if (language === undefined) return this.unsupported('symbols')

    const attempts: PluginExecutionAttempt[] = []
    for (const candidate of this.getCandidates(ctx.repoRoot, language.id, 'symbols')) {
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        attempts.push(this.unavailableAttempt(candidate.analyzer.id, candidate.analyzer.kind, bin))
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getSymbols(
            ctx.filePath,
            language.id,
            ctx.repoRoot,
            candidate.analyzer.command,
            false,
          )
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'lsp',
            status: result.symbols.length > 0 ? 'success' : 'no_result',
            durationMs: Date.now() - started,
            errorMessage: result.error,
            metadata: { symbolCount: result.symbols.length, kind: candidate.analyzer.kind },
          })
          if (result.symbols.length > 0) {
            return { items: result.symbols, pluginId: this.id, mode: 'lsp', attempts, error: result.error }
          }
          continue
        }

        if (candidate.analyzer.kind === 'heuristic') {
          const symbols = heuristicSymbols(readFileSync(ctx.filePath, 'utf8'))
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'heuristic',
            status: symbols.length > 0 ? 'success' : 'no_result',
            durationMs: Date.now() - started,
            metadata: { symbolCount: symbols.length, kind: candidate.analyzer.kind, mode: 'heuristic' },
          })
          if (symbols.length > 0) {
            return { items: symbols, pluginId: this.id, mode: 'heuristic', attempts }
          }
          continue
        }

        attempts.push(this.unsupportedAttempt(candidate.analyzer.id, candidate.analyzer.kind, 'symbol execution not implemented'))
      } catch (err) {
        attempts.push(this.errorAttempt(candidate.analyzer.id, candidate.analyzer.kind, Date.now() - started, err))
      }
    }

    return { items: [], pluginId: this.id, attempts, error: `no-symbols: ${ctx.filePath}` }
  }

  async getDiagnostics(ctx: PluginContext): Promise<PluginResult<PluginDiagnostic>> {
    const language = this.requireLanguage(ctx.languageId)
    if (language === undefined) return this.unsupported('diagnostics')

    const attempts: PluginExecutionAttempt[] = []
    for (const candidate of this.getCandidates(ctx.repoRoot, language.id, 'diagnostics')) {
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        attempts.push(this.unavailableAttempt(candidate.analyzer.id, candidate.analyzer.kind, bin))
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getDiagnostics(
            ctx.filePath,
            language.id,
            ctx.repoRoot,
            candidate.analyzer.command,
          )
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'lsp',
            status: result.error === undefined ? 'success' : 'no_result',
            durationMs: Date.now() - started,
            errorMessage: result.error,
            metadata: { diagnosticCount: result.diagnostics.length, kind: candidate.analyzer.kind },
          })
          if (result.error === undefined) {
            return { items: result.diagnostics, pluginId: this.id, attempts }
          }
          continue
        }

        if (candidate.analyzer.kind === 'quality') {
          const result = this.executeQualityAnalyzer(candidate.analyzer, ctx.filePath, ctx.repoRoot, language.id)
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'quality',
            status: 'success',
            durationMs: Date.now() - started,
            metadata: {
              diagnosticCount: result.diagnostics.length,
              kind: candidate.analyzer.kind,
              exitError: result.error ?? null,
            },
          })
          return { items: result.diagnostics, pluginId: this.id, attempts, error: result.error }
        }

        attempts.push(this.unsupportedAttempt(candidate.analyzer.id, candidate.analyzer.kind, 'diagnostics execution not implemented'))
      } catch (err) {
        attempts.push(this.errorAttempt(candidate.analyzer.id, candidate.analyzer.kind, Date.now() - started, err))
      }
    }

    return { items: [], pluginId: this.id, attempts, error: `no-diagnostics: ${ctx.filePath}` }
  }

  async getReferences(query: ReferencesQuery): Promise<PluginResult<PluginReference>> {
    const language = this.requireLanguage(query.languageId)
    if (language === undefined) return this.unsupported('references')

    const attempts: PluginExecutionAttempt[] = []
    for (const candidate of this.getCandidates(query.repoRoot, language.id, 'references')) {
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        attempts.push(this.unavailableAttempt(candidate.analyzer.id, candidate.analyzer.kind, bin))
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getReferences(
            query.filePath,
            language.id,
            query.position,
            query.repoRoot,
            candidate.analyzer.command,
            this.workspaceFilePaths(query.repoRoot, query.filePath, language),
          )
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'lsp',
            status: result.locations.length > 0 ? 'success' : 'no_result',
            durationMs: Date.now() - started,
            errorMessage: result.error,
            metadata: { referenceCount: result.locations.length, kind: candidate.analyzer.kind },
          })
          if (result.locations.length > 0) {
            return {
              items: result.locations.map(location => ({ path: location.path, range: location.range })),
              pluginId: this.id,
              attempts,
            }
          }
          continue
        }

        attempts.push(this.unsupportedAttempt(candidate.analyzer.id, candidate.analyzer.kind, 'reference execution not implemented'))
      } catch (err) {
        attempts.push(this.errorAttempt(candidate.analyzer.id, candidate.analyzer.kind, Date.now() - started, err))
      }
    }

    return { items: [], pluginId: this.id, attempts, error: `no-references: ${query.filePath}` }
  }

  async getDefinitions(query: DefinitionsQuery): Promise<PluginResult<PluginDefinition>> {
    const language = this.requireLanguage(query.languageId)
    if (language === undefined || query.position === undefined) return this.unsupported('definitions')

    const attempts: PluginExecutionAttempt[] = []
    for (const candidate of this.getCandidates(query.repoRoot, language.id, 'definitions')) {
      const bin = candidate.analyzer.command[0] ?? ''
      if (candidate.analyzer.kind !== 'heuristic' && !this.commandExists(bin)) {
        attempts.push(this.unavailableAttempt(candidate.analyzer.id, candidate.analyzer.kind, bin))
        continue
      }

      const started = Date.now()
      try {
        if (candidate.analyzer.kind === 'lsp') {
          const result = await this.lsp.getDefinitions(
            query.filePath,
            language.id,
            query.position,
            query.repoRoot,
            candidate.analyzer.command,
            this.workspaceFilePaths(query.repoRoot, query.filePath, language),
          )
          attempts.push({
            analyzerId: candidate.analyzer.id,
            analyzerKind: 'lsp',
            status: result.locations.length > 0 ? 'success' : 'no_result',
            durationMs: Date.now() - started,
            errorMessage: result.error,
            metadata: { definitionCount: result.locations.length, kind: candidate.analyzer.kind },
          })
          if (result.locations.length > 0) {
            return {
              items: result.locations.map(location => ({
                name: query.symbol,
                kind: 'Definition',
                path: location.path,
                range: location.range,
                selectionRange: location.range,
              })),
              pluginId: this.id,
              attempts,
            }
          }
          continue
        }

        attempts.push(this.unsupportedAttempt(candidate.analyzer.id, candidate.analyzer.kind, 'definition execution not implemented'))
      } catch (err) {
        attempts.push(this.errorAttempt(candidate.analyzer.id, candidate.analyzer.kind, Date.now() - started, err))
      }
    }

    return { items: [], pluginId: this.id, attempts, error: `no-definitions: ${query.filePath}` }
  }

  private executeQualityAnalyzer(
    analyzer: RegistryAnalyzer,
    filePath: string,
    repoRoot: string,
    languageId: string,
  ): { diagnostics: PluginDiagnostic[]; error?: string } {
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

  private requireLanguage(query: string): RegistryLanguage | undefined {
    const normalized = query.toLowerCase()
    return this.registry.languages.find(language =>
      !this.excludedLanguageIds.has(language.id) &&
      (language.id === normalized ||
        language.display_name.toLowerCase() === normalized ||
        (language.aliases ?? []).some(alias => alias.toLowerCase() === normalized))
    )
  }

  private findLanguageFromPath(filePath: string): RegistryLanguage | undefined {
    return this.registry.languages.find(language =>
      !this.excludedLanguageIds.has(language.id) &&
      (language.detect.extensions ?? []).some(ext => filePath.endsWith(ext))
    )
  }

  private workspaceFilePaths(repoRoot: string, filePath: string, language: RegistryLanguage): string[] {
    const extensions = language.detect.extensions ?? []
    const workspacePaths = extensions.length > 0
      ? collectWorkspaceFiles(repoRoot, extensions)
      : [filePath]
    return workspacePaths.includes(filePath) ? workspacePaths : [filePath, ...workspacePaths]
  }

  private getCandidates(repoRoot: string, languageId: string, capability: Capability): ResolvedAnalyzer[] {
    const language = this.requireLanguage(languageId)
    if (language === undefined) return []

    const registryCapability = capability === 'references' ? 'refs' : (capability === 'definitions' ? 'defs' : capability)
    return language.analyzers
      .filter(analyzer => analyzer.capabilities.includes(registryCapability))
      .filter(analyzer => this.isAnalyzerEligible(analyzer, repoRoot))
      .map(analyzer => ({ language, analyzer }))
      .sort((a, b) => b.analyzer.priority - a.analyzer.priority)
  }

  private isAnalyzerEligible(analyzer: RegistryAnalyzer, repoRoot: string): boolean {
    if ((analyzer.required_files ?? []).length === 0) return true
    return analyzer.required_files?.every(file => existsSync(`${repoRoot}/${file}`)) ?? true
  }

  private unavailableAttempt(analyzerId: string, analyzerKind: PluginExecutionAttempt['analyzerKind'], bin: string): PluginExecutionAttempt {
    return {
      analyzerId,
      analyzerKind,
      status: 'unavailable',
      durationMs: 0,
      errorMessage: `tool not found: ${bin}`,
    }
  }

  private unsupportedAttempt(analyzerId: string, analyzerKind: PluginExecutionAttempt['analyzerKind'], message: string): PluginExecutionAttempt {
    return {
      analyzerId,
      analyzerKind,
      status: 'unsupported',
      durationMs: 0,
      errorMessage: message,
    }
  }

  private errorAttempt(analyzerId: string, analyzerKind: PluginExecutionAttempt['analyzerKind'], durationMs: number, err: unknown): PluginExecutionAttempt {
    return {
      analyzerId,
      analyzerKind,
      status: 'error',
      durationMs,
      errorMessage: err instanceof Error ? err.message : String(err),
    }
  }

  private unsupported<T>(capability: string): PluginResult<T> {
    return {
      items: [],
      pluginId: this.id,
      attempts: [],
      error: `unsupported-capability: ${capability}`,
    }
  }
}
