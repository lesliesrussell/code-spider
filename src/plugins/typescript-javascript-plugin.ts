import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
// code-spider-9jk
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'

type SupportedLanguageId = 'typescript' | 'javascript'

export class TypeScriptJavaScriptPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.typescript-javascript'
  readonly displayName = 'Built-in TypeScript/JavaScript Plugin'
  readonly languageIds = ['typescript', 'javascript']
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'health'] as const

  // code-spider-9jk
  // No quality analyzers; preserves the historical pluralised "symbols"
  // message in the unimplemented-kind attempt.
  protected override readonly supportsQualityDiagnostics = false
  protected override readonly symbolsUnsupportedMessage = 'symbols execution not implemented'

  protected matchesLanguage(language: RegistryLanguage): boolean {
    return this.languageIds.includes(language.id as SupportedLanguageId)
  }

  detect(repoRoot: string, filePath: string): PluginDetectionResult {
    const language = this.findLanguageFromPath(filePath)
    if (language === undefined) return { supported: false, confidence: 0 }
    const candidates = this.getCandidates(repoRoot, language.id, 'symbols')
    return {
      supported: true,
      confidence: candidates.length > 0 ? 0.9 : 0.6,
      languageId: language.id,
      reason: candidates.length > 0 ? undefined : 'no configured analyzers matched',
    }
  }

  health(repoRoot: string): PluginHealth {
    const candidates = this.languageIds.flatMap(languageId => this.getCandidates(repoRoot, languageId, 'symbols'))
    const available = candidates.some(candidate => this.commandExists(candidate.analyzer.command[0] ?? ''))
    return {
      available,
      toolName: 'typescript-language-server',
      details: available ? undefined : 'No TypeScript/JavaScript semantic provider available',
    }
  }

  capabilityStatus(repoRoot: string): Record<'symbols' | 'definitions' | 'references' | 'diagnostics' | 'health', PluginCapabilityStatus> {
    const supports = (capability: PluginCapability): PluginCapabilityStatus => {
      const candidates = this.languageIds.flatMap(languageId => this.getCandidates(repoRoot, languageId, capability))
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
