export const LANGUAGE_PLUGIN_CAPABILITIES = [
  'symbols',
  'definitions',
  'references',
  'diagnostics',
  'health',
] as const

export type LanguagePluginCapability = typeof LANGUAGE_PLUGIN_CAPABILITIES[number]

export interface PluginPosition {
  line: number
  character: number
}

export interface PluginRange {
  start: PluginPosition
  end: PluginPosition
}

export type PluginSymbolSignal = 'low'

export interface PluginSymbol {
  name: string
  kind: string
  kindId?: number
  containerName?: string
  range: PluginRange
  selectionRange?: PluginRange
  signature?: string
  signal?: PluginSymbolSignal
  provenance?: 'semantic' | 'heuristic'
}

export interface PluginDefinition {
  name: string
  kind: string
  path: string
  range: PluginRange
  selectionRange?: PluginRange
  containerName?: string
  signature?: string
  provenance?: 'semantic' | 'heuristic'
}

export interface PluginReference {
  path: string
  range: PluginRange
}

export type PluginDiagnosticSeverity = 1 | 2 | 3 | 4

export interface PluginDiagnostic {
  severity: PluginDiagnosticSeverity
  message: string
  range: PluginRange
  code?: string
}

export interface PluginHealth {
  available: boolean
  toolName: string
  version?: string
  details?: string
}

export interface PluginCapabilityStatus {
  supported: boolean
  available: boolean
  degraded?: boolean
  reason?: string
}

export interface PluginDetectionResult {
  supported: boolean
  confidence: number
  reason?: string
}

export interface PluginContext {
  repoRoot: string
  filePath: string
  languageId: string
}

export interface DefinitionsQuery extends PluginContext {
  symbol: string
}

export interface ReferencesQuery extends PluginContext {
  position: PluginPosition
}

export interface PluginResult<T> {
  items: T[]
  degraded?: boolean
  degradationReason?: string
  pluginId: string
  mode?: string
  attempts: PluginExecutionAttempt[]
  error?: string
}

export interface PluginExecutionAttempt {
  analyzerId: string
  analyzerKind: 'lsp' | 'quality' | 'heuristic'
  status: 'success' | 'no_result' | 'unavailable' | 'unsupported' | 'error'
  durationMs: number
  errorMessage?: string
  metadata?: Record<string, unknown>
}

export interface LanguagePlugin {
  id: string
  displayName: string
  languageIds: string[]
  capabilities: readonly LanguagePluginCapability[]

  detect(repoRoot: string, filePath: string): PluginDetectionResult
  health(repoRoot: string): PluginHealth
  capabilityStatus(repoRoot: string): Record<LanguagePluginCapability, PluginCapabilityStatus>

  getSymbols(ctx: PluginContext): Promise<PluginResult<PluginSymbol>>
  getDefinitions(query: DefinitionsQuery): Promise<PluginResult<PluginDefinition>>
  getReferences(query: ReferencesQuery): Promise<PluginResult<PluginReference>>
  getDiagnostics(ctx: PluginContext): Promise<PluginResult<PluginDiagnostic>>
}
