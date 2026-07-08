import type { AnalyzerRegistryDocument, RegistryLanguage } from '../analyzer-registry'
import type {
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
import { LspAdapter } from '../adapters/lsp'
// code-spider-9jk
import { BaseRegistryPlugin } from './base-plugin'

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
    // code-spider-y9e
    return this.registryDetect(repoRoot, filePath, ['symbols', 'diagnostics', 'references'], { withCandidates: 0.8, without: 0.5 })
  }

  health(repoRoot: string): PluginHealth {
    // code-spider-y9e
    const candidates = this.collectCandidates(repoRoot, ['symbols', 'diagnostics', 'references'])
    const available = candidates.some(candidate =>
      candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
    )
    return {
      available,
      toolName: 'registry-defined analyzers',
      details: available ? undefined : 'No registry-based semantic providers available',
    }
  }
}
