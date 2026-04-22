export type NodeKind = 'repo' | 'zone' | 'flow' | 'unit' | 'atom' | 'doc' | 'doc_section' | 'issue'
export type EdgeKind = 'calls' | 'references' | 'imports' | 'extends' | 'contains' | 'defined-in' | 'tested-by' | 'changed-with' | 'configures' | 'emits-event' | 'consumes-event' | 'routes-to' | 'mentions' | 'documents' | 'explains' | 'tracked-by' | 'depends-on'
export type AnalyzerKind = 'structural' | 'heuristic' | 'semantic' | 'quality'
export type EvidenceKind = 'grep' | 'git' | 'lsp' | 'manifest' | 'test' | 'markdown' | 'beads'
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint'

export interface CliContext {
  repoRoot: string      // resolved path to repo being analyzed
  dbPath: string        // default repo-local DB path unless overridden by --db
  json: boolean         // --json flag
  args: string[]        // remaining positional args after command
  flags: Record<string, string | boolean>
}
