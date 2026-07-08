// code-spider-e32
import { readFileSync } from 'node:fs'
import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
import { BaseRegistryPlugin } from './base-plugin'

const SHEBANG_RE = /^#!.*\b(bash|sh|zsh)\b/

export class ShellPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.shell'
  readonly displayName = 'Built-in Shell Plugin'
  readonly languageIds = ['shell']
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'definitions', 'health'] as const

  protected matchesLanguage(language: RegistryLanguage): boolean {
    return language.id === 'shell'
  }

  detect(_repoRoot: string, filePath: string): PluginDetectionResult {
    const language = this.findLanguageFromPath(filePath)
    if (language !== undefined) {
      return { supported: true, confidence: 0.9, languageId: language.id }
    }
    try {
      const firstLine = readFileSync(filePath, 'utf8').split('\n')[0] ?? ''
      if (SHEBANG_RE.test(firstLine)) {
        return { supported: true, confidence: 0.7, languageId: 'shell', reason: 'shebang' }
      }
    } catch {
      // unreadable file — not our language
    }
    return { supported: false, confidence: 0 }
  }

  health(_repoRoot: string): PluginHealth {
    const hasLsp = this.commandExists('bash-language-server')
    return {
      available: true,
      toolName: 'bash-language-server',
      details: hasLsp ? undefined : 'bash-language-server not found; heuristic symbols only',
    }
  }
}
