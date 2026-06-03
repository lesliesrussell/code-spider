export const SCHEMA: string[] = [
  // Core tables
  `CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  repo_root TEXT NOT NULL,
  repo_commit TEXT,
  tool_version TEXT
)`,
  `CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT,
  language TEXT,
  summary TEXT,
  score REAL DEFAULT 0,
  confidence REAL DEFAULT 0,
  metadata_json TEXT,
  UNIQUE(run_id, kind, key)
)`,
  `CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  from_node_id INTEGER NOT NULL REFERENCES nodes(id),
  to_node_id INTEGER NOT NULL REFERENCES nodes(id),
  kind TEXT NOT NULL,
  weight REAL DEFAULT 1,
  metadata_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id INTEGER REFERENCES nodes(id),
  edge_id INTEGER REFERENCES edges(id),
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  locator TEXT,
  snippet TEXT,
  score REAL DEFAULT 0
)`,
  `CREATE TABLE IF NOT EXISTS stats (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  metric TEXT NOT NULL,
  value REAL NOT NULL
)`,
  // Semantic tables
  `CREATE TABLE IF NOT EXISTS analyzers (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  language TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  version TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS analyzer_runs (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  analyzer_id INTEGER NOT NULL REFERENCES analyzers(id),
  node_id INTEGER REFERENCES nodes(id),
  language TEXT NOT NULL,
  capability TEXT NOT NULL,
  status TEXT NOT NULL,
  target TEXT,
  duration_ms INTEGER,
  error_message TEXT,
  metadata_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  symbol_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container_name TEXT,
  signature TEXT,
  type_info TEXT,
  range_json TEXT,
  selection_range_json TEXT,
  metadata_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS symbol_edges (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  from_symbol_id INTEGER NOT NULL REFERENCES symbols(id),
  to_symbol_id INTEGER NOT NULL REFERENCES symbols(id),
  kind TEXT NOT NULL,
  metadata_json TEXT
)`,
  `CREATE TABLE IF NOT EXISTS diagnostics (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  node_id INTEGER REFERENCES nodes(id),
  symbol_id INTEGER REFERENCES symbols(id),
  analyzer_id INTEGER NOT NULL REFERENCES analyzers(id),
  severity TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  range_json TEXT,
  metadata_json TEXT
)`,
  // Investigation tables
  `CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY,
  run_id INTEGER REFERENCES runs(id),
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS investigation_nodes (
  investigation_id INTEGER NOT NULL REFERENCES investigations(id),
  node_id INTEGER NOT NULL REFERENCES nodes(id),
  note TEXT,
  PRIMARY KEY (investigation_id, node_id)
)`,
  `CREATE TABLE IF NOT EXISTS investigation_evidence (
  investigation_id INTEGER NOT NULL REFERENCES investigations(id),
  evidence_id INTEGER NOT NULL REFERENCES evidence(id),
  note TEXT,
  PRIMARY KEY (investigation_id, evidence_id)
)`,
  // code-spider-xbf
  // Indexes for the hot query paths. Without these every navigator, flow,
  // related, doctor-coverage, and semantic query full-scans its table.
  // nodes: looked up by (run_id, kind) with path filters, by key, by path.
  `CREATE INDEX IF NOT EXISTS idx_nodes_run_kind ON nodes(run_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_run_path ON nodes(run_id, path)`,
  `CREATE INDEX IF NOT EXISTS idx_nodes_run_key ON nodes(run_id, key)`,
  // edges: traversed by kind within a run and joined from either endpoint.
  `CREATE INDEX IF NOT EXISTS idx_edges_run_kind ON edges(run_id, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_node_id)`,
  // evidence/stats/diagnostics: fetched per node within a run.
  `CREATE INDEX IF NOT EXISTS idx_evidence_run_node ON evidence(run_id, node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stats_run_node ON stats(run_id, node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_stats_run_metric ON stats(run_id, metric)`,
  `CREATE INDEX IF NOT EXISTS idx_diagnostics_run_node ON diagnostics(run_id, node_id)`,
  // symbols: joined by node and searched by name (refs/defs/related overlap).
  `CREATE INDEX IF NOT EXISTS idx_symbols_run_name ON symbols(run_id, name)`,
  `CREATE INDEX IF NOT EXISTS idx_symbols_node ON symbols(node_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_edges_from ON symbol_edges(from_symbol_id)`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_edges_to ON symbol_edges(to_symbol_id)`,
  // analyzer_runs: doctor coverage aggregates per run.
  `CREATE INDEX IF NOT EXISTS idx_analyzer_runs_run ON analyzer_runs(run_id)`,
]
