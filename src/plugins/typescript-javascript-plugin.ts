import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
// code-spider-9jk
import { BaseRegistryPlugin } from './base-plugin'

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
    // code-spider-y9e
    return this.registryDetect(repoRoot, filePath, ['symbols'])
  }

  health(repoRoot: string): PluginHealth {
    // code-spider-y9e
    const candidates = this.collectCandidates(repoRoot, ['symbols'])
    const available = candidates.some(candidate => this.commandExists(candidate.analyzer.command[0] ?? ''))
    return {
      available,
      toolName: 'typescript-language-server',
      details: available ? undefined : 'No TypeScript/JavaScript semantic provider available',
    }
  }
}
