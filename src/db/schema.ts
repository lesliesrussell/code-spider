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
]
