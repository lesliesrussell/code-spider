import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
// code-spider-9jk
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'

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
    const language = this.findLanguageFromPath(filePath)
    if (language === undefined) return { supported: false, confidence: 0 }
    const candidates = ['symbols', 'diagnostics', 'references'].flatMap(capability =>
      this.getCandidates(repoRoot, language.id, capability as PluginCapability),
    )
    return {
      supported: true,
      confidence: candidates.length > 0 ? 0.9 : 0.6,
      languageId: language.id,
      reason: candidates.length > 0 ? undefined : 'no configured analyzers matched',
    }
  }

  health(repoRoot: string): PluginHealth {
    const candidates = ['symbols', 'diagnostics', 'references'].flatMap(capability =>
      this.getCandidates(repoRoot, 'zig', capability as PluginCapability),
    )
    const available = candidates.some(candidate =>
      candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
    )
    return {
      available,
      toolName: 'zls',
      details: available ? undefined : 'No Zig semantic provider available',
    }
  }

  capabilityStatus(repoRoot: string): Record<'symbols' | 'definitions' | 'references' | 'diagnostics' | 'health', PluginCapabilityStatus> {
    const supports = (capability: PluginCapability): PluginCapabilityStatus => {
      const candidates = this.getCandidates(repoRoot, 'zig', capability)
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
