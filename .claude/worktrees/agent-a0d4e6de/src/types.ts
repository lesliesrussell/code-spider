export type NodeKind = 'repo' | 'zone' | 'flow' | 'unit' | 'atom'
export type EdgeKind = 'calls' | 'references' | 'imports' | 'extends' | 'contains' | 'defined-in' | 'tested-by' | 'changed-with' | 'configures' | 'emits-event' | 'consumes-event' | 'routes-to'
export type AnalyzerKind = 'structural' | 'heuristic' | 'semantic' | 'quality'
export type EvidenceKind = 'grep' | 'git' | 'lsp' | 'manifest' | 'test'
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface CliContext {
  repoRoot: string      // resolved path to repo being analyzed
  dbPath: string        // .code-spider/index.db inside repoRoot
  json: boolean         // --json flag
  args: string[]        // remaining positional args after command
  flags: Record<string, string | boolean>
}
