import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
// code-spider-9jk
import { BaseRegistryPlugin } from './base-plugin'

export class ZigPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.zig'
  readonly displayName = 'Built-in Zig Plugin'
  readonly languageIds = ['zig']
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'health'] as const

  // code-spider-9jk
  // Zig gates every analyzer on commandExists (no heuristic extractor) and so
  // has no heuristic symbol fallback.
  protected override commandRequiredFor(): boolean {
    return true
  }
  protected override readonly supportsHeuristicSymbols = false

  protected matchesLanguage(language: RegistryLanguage): boolean {
    return language.id === 'zig'
  }

  detect(repoRoot: string, filePath: string): PluginDetectionResult {
    // code-spider-y9e
    return this.registryDetect(repoRoot, filePath, ['symbols', 'diagnostics', 'references'])
  }

  health(repoRoot: string): PluginHealth {
    // code-spider-y9e
    const candidates = this.collectCandidates(repoRoot, ['symbols', 'diagnostics', 'references'])
    const available = candidates.some(candidate =>
      candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
    )
    return {
      available,
      toolName: 'zls',
      details: available ? undefined : 'No Zig semantic provider available',
    }
  }
}
