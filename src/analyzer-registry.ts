export const ANALYZER_REGISTRY_VERSION = 1 as const

export const ANALYZER_CAPABILITIES = [
  'symbols',
  'defs',
  'refs',
  'diagnostics',
] as const

export const ANALYZER_KINDS = [
  'lsp',
  'quality',
  'heuristic',
] as const

export type AnalyzerCapability = typeof ANALYZER_CAPABILITIES[number]
export type AnalyzerKind = typeof ANALYZER_KINDS[number]

export interface RegistryLanguageDetect {
  extensions?: string[]
  manifests?: string[]
}

export interface RegistryAnalyzer {
  id: string
  kind: AnalyzerKind
  tool: string
  command: string[]
  capabilities: AnalyzerCapability[]
  priority: number
  required_files?: string[]
  notes?: string
}

export interface RegistryLanguage {
  id: string
  display_name: string
  aliases?: string[]
  detect: RegistryLanguageDetect
  analyzers: RegistryAnalyzer[]
}

export interface AnalyzerRegistryDocument {
  version: number
  capabilities?: AnalyzerCapability[]
  languages: RegistryLanguage[]
}

