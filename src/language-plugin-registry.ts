import type { AnalyzerRegistryDocument } from './analyzer-registry'
import { LspAdapter } from './adapters/lsp'
import type { LanguagePlugin } from './language-plugin'
import { TypeScriptJavaScriptPlugin } from './plugins/typescript-javascript-plugin'

export class BuiltinLanguagePluginRegistry {
  private readonly plugins: LanguagePlugin[]

  constructor(
    registry: AnalyzerRegistryDocument,
    commandExists: (bin: string) => boolean,
    lsp: Pick<LspAdapter, 'getSymbols' | 'getDiagnostics' | 'getReferences'> = new LspAdapter(),
  ) {
    this.plugins = [
      new TypeScriptJavaScriptPlugin(registry, commandExists, lsp),
    ]
  }

  getByLanguage(languageId: string): LanguagePlugin | undefined {
    const normalized = languageId.toLowerCase()
    return this.plugins.find(plugin => plugin.languageIds.some(id => id === normalized))
  }
}

