import { join } from 'node:path'
import type { AnalyzerRegistryDocument } from './analyzer-registry'
import { LspAdapter } from './adapters/lsp'
import type { LanguagePlugin } from './language-plugin'
import { RegistryLegacyPlugin } from './plugins/registry-legacy-plugin'
import { TypeScriptJavaScriptPlugin } from './plugins/typescript-javascript-plugin'
import { ZigPlugin } from './plugins/zig-plugin'
// code-spider-due
import { CppPlugin } from './plugins/cpp-plugin'
// code-spider-e32
import { ShellPlugin } from './plugins/shell-plugin'

export interface DetectedPluginLanguage {
  languageId: string
  pluginId: string
  confidence: number
  reason?: string
}

export class BuiltinLanguagePluginRegistry {
  private readonly registry: AnalyzerRegistryDocument
  private readonly plugins: LanguagePlugin[]
  private readonly legacyPlugin: RegistryLegacyPlugin

  constructor(
    registry: AnalyzerRegistryDocument,
    commandExists: (bin: string) => boolean,
    lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences' | 'getDefinitions'> = new LspAdapter(),
  ) {
    this.registry = registry
    this.plugins = [
      new TypeScriptJavaScriptPlugin(registry, commandExists, lsp),
      new ZigPlugin(registry, commandExists, lsp),
      // code-spider-due
      new CppPlugin(registry, commandExists, lsp),
      // code-spider-e32
      new ShellPlugin(registry, commandExists, lsp),
    ]
    this.legacyPlugin = new RegistryLegacyPlugin(
      registry,
      commandExists,
      lsp,
      new Set(this.plugins.flatMap(plugin => plugin.languageIds)),
    )
  }

  getByLanguage(languageId: string): LanguagePlugin | undefined {
    const normalized = languageId.toLowerCase()
    return this.plugins.find(plugin => plugin.languageIds.some(id => id === normalized)) ?? this.legacyPlugin
  }

  normalizeLanguageId(query: string): string | undefined {
    const normalized = query.toLowerCase()
    return this.registry.languages.find(language =>
      language.id === normalized ||
      language.display_name.toLowerCase() === normalized ||
      (language.aliases ?? []).some(alias => alias.toLowerCase() === normalized)
    )?.id
  }

  getSupportedLanguages(): string[] {
    return this.registry.languages.flatMap(language => [
      language.id,
      language.display_name,
      ...(language.aliases ?? []),
    ])
  }

  detectLanguages(repoRoot: string, relPaths: string[]): DetectedPluginLanguage[] {
    const allPlugins = [...this.plugins, this.legacyPlugin]
    const bestByLanguage = new Map<string, DetectedPluginLanguage>()

    for (const relPath of relPaths) {
      const filePath = join(repoRoot, relPath)
      for (const plugin of allPlugins) {
        const detection = plugin.detect(repoRoot, filePath)
        if (!detection.supported || detection.languageId === undefined) continue
        const existing = bestByLanguage.get(detection.languageId)
        if (existing !== undefined && existing.confidence >= detection.confidence) continue
        bestByLanguage.set(detection.languageId, {
          languageId: detection.languageId,
          pluginId: plugin.id,
          confidence: detection.confidence,
          reason: detection.reason,
        })
      }
    }

    return [...bestByLanguage.values()].sort((a, b) => a.languageId.localeCompare(b.languageId))
  }
}
