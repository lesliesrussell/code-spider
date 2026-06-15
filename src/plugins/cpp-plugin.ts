// code-spider-due
import { spawnSync } from 'node:child_process'
import type { RegistryAnalyzer, RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginDiagnostic,
  PluginHealth,
} from '../language-plugin'
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'
// code-spider-ua1
import { buildClangTidyArgs, buildCppcheckArgs, findCompileDb, parseToolOutput } from './shared/cpp-quality'

// clang-tidy / cppcheck can be slow on large translation units; allow more
// headroom than the base 10s quality timeout.
const CPP_QUALITY_TIMEOUT_MS = 60_000

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

  // code-spider-ua1
  // The base quality path collapses any non-zero exit into a single blob
  // diagnostic. clang-tidy and cppcheck carry per-finding location/severity/
  // check-name we want preserved, so route them through the structured
  // parsers. A compile_commands.json (when present) sharpens clang-tidy.
  protected override executeQualityAnalyzer(
    analyzer: RegistryAnalyzer,
    filePath: string,
    repoRoot: string,
    _languageId: string,
  ): { diagnostics: PluginDiagnostic[]; error?: string } {
    const tool = analyzer.tool
    if (tool !== 'clang-tidy' && tool !== 'cppcheck') {
      return super.executeQualityAnalyzer(analyzer, filePath, repoRoot, _languageId)
    }

    const args = tool === 'clang-tidy'
      ? buildClangTidyArgs(filePath, findCompileDb(repoRoot))
      : buildCppcheckArgs(filePath)

    const result = spawnSync(tool, args, {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: CPP_QUALITY_TIMEOUT_MS,
    })
    if (result.error) return { diagnostics: [], error: result.error.message }

    // Non-zero exit is normal for these tools when findings exist — parse the
    // output regardless of status.
    return { diagnostics: parseToolOutput(tool, result.stdout ?? '', result.stderr ?? '') }
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
