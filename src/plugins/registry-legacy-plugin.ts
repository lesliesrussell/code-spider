import type { AnalyzerRegistryDocument, RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
import { LspAdapter } from '../adapters/lsp'
// code-spider-9jk
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'

export class RegistryLegacyPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.registry-legacy'
  readonly displayName = 'Built-in Registry Legacy Plugin'
  readonly languageIds: string[] = []
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'health'] as const

  // code-spider-9jk
  // Languages already owned by a specific plugin are excluded here so the
  // legacy fallback never double-handles them.
  private readonly excludedLanguageIds: Set<string>

  constructor(
    registry: AnalyzerRegistryDocument,
    commandExists: (bin: string) => boolean,
    lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences' | 'getDefinitions'> = new LspAdapter(),
    excludedLanguageIds = new Set<string>(),
  ) {
    super(registry, commandExists, lsp)
    this.excludedLanguageIds = excludedLanguageIds
  }

  protected matchesLanguage(language: RegistryLanguage): boolean {
    return !this.excludedLanguageIds.has(language.id)
  }

  detect(repoRoot: string, filePath: string): PluginDetectionResult {
    const language = this.findLanguageFromPath(filePath)
    if (language === undefined) return { supported: false, confidence: 0 }
    const candidates = ['symbols', 'diagnostics', 'references'].flatMap(capability =>
      this.getCandidates(repoRoot, language.id, capability as PluginCapability),
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
        this.getCandidates(repoRoot, language.id, capability as PluginCapability),
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
    const supports = (capability: PluginCapability): PluginCapabilityStatus => {
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
}
