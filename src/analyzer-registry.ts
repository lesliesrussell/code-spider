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

export interface AnalyzerRegistryValidationRule {
  field: string
  expectation: string
}

export const ANALYZER_REGISTRY_VALIDATION_RULES: AnalyzerRegistryValidationRule[] = [
  { field: 'version', expectation: `must equal ${ANALYZER_REGISTRY_VERSION}` },
  { field: 'languages', expectation: 'must be a non-empty list' },
  { field: 'languages[].id', expectation: 'must be a stable lowercase identifier' },
  { field: 'languages[].display_name', expectation: 'must be a human-readable name' },
  { field: 'languages[].detect', expectation: 'must define at least one detection signal' },
  { field: 'languages[].detect.extensions', expectation: 'entries must include the leading dot when present' },
  { field: 'languages[].analyzers', expectation: 'must be a non-empty list' },
  { field: 'languages[].analyzers[].id', expectation: 'must be unique within the language' },
  { field: 'languages[].analyzers[].kind', expectation: `must be one of: ${ANALYZER_KINDS.join(', ')}` },
  { field: 'languages[].analyzers[].tool', expectation: 'must be the executable/tool name' },
  { field: 'languages[].analyzers[].command', expectation: 'must be a non-empty argv template array' },
  { field: 'languages[].analyzers[].capabilities', expectation: `must contain only: ${ANALYZER_CAPABILITIES.join(', ')}` },
  { field: 'languages[].analyzers[].priority', expectation: 'must be an integer, higher values preferred' },
]
