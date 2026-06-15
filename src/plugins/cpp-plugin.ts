// code-spider-due
import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'

type SupportedLanguageId = 'c' | 'cpp'

export class CppPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.cpp'
  readonly displayName = 'Built-in C/C++ Plugin'
  readonly languageIds = ['c', 'cpp']
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'health'] as const

  // C/C++ keeps the default heuristic symbol fallback (cpp-heuristic) and the
  // default quality-diagnostics path (clang-tidy / cppcheck). The structured
  // parsing of those tools is layered in by code-spider-ua1.

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
    const available = candidates.some(candidate =>
      candidate.analyzer.kind !== 'heuristic' && this.commandExists(candidate.analyzer.command[0] ?? ''),
    )
    return {
      available,
      toolName: 'clangd',
      details: available ? undefined : 'No C/C++ semantic provider available (clangd not found)',
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
