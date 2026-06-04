// code-spider-ohm
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Database } from 'bun:sqlite'
import { openDb } from './init'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'code-spider-db-init-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('openDb cache .gitignore', () => {
  test('writes .gitignore excluding the index when creating .code-spider', () => {
    const db = openDb(join(root, '.code-spider', 'index.db'))
    db.close()
    const content = readFileSync(join(root, '.code-spider', '.gitignore'), 'utf8')
    expect(content).toContain('index.db*')
  })

  test('does not overwrite an existing .gitignore', () => {
    mkdirSync(join(root, '.code-spider'), { recursive: true })
    writeFileSync(join(root, '.code-spider', '.gitignore'), '# user rules\n')
    const db = openDb(join(root, '.code-spider', 'index.db'))
    db.close()
    expect(readFileSync(join(root, '.code-spider', '.gitignore'), 'utf8')).toBe('# user rules\n')
  })

  test('does not write .gitignore for non-default db locations', () => {
    const db = openDb(join(root, 'custom-dir', 'index.db'))
    db.close()
    expect(existsSync(join(root, 'custom-dir', '.gitignore'))).toBe(false)
  })
})

// code-spider-0ok
describe('intelligence schema', () => {
  test('new databases have a findings table and edges.confidence', () => {
    const db = openDb(join(root, '.code-spider', 'index.db'))
    const findingsCols = db.query("PRAGMA table_info(findings)").all() as Array<{ name: string }>
    expect(findingsCols.map(c => c.name)).toContain('fingerprint')
    const edgeCols = db.query("PRAGMA table_info(edges)").all() as Array<{ name: string }>
    expect(edgeCols.map(c => c.name)).toContain('confidence')
    db.close()
  })

  test('legacy databases gain edges.confidence with default 1.0', () => {
    // Simulate a pre-intelligence DB: edges table without confidence.
    const dbPath = join(root, 'legacy.db')
    const legacy = new Database(dbPath, { create: true })
    legacy.query(`CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, repo_root TEXT NOT NULL, repo_commit TEXT, tool_version TEXT)`).run()
    legacy.query(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, path TEXT, language TEXT, summary TEXT, score REAL DEFAULT 0, confidence REAL DEFAULT 0, metadata_json TEXT, UNIQUE(run_id, kind, key))`).run()
    legacy.query(`CREATE TABLE edges (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), from_node_id INTEGER NOT NULL REFERENCES nodes(id), to_node_id INTEGER NOT NULL REFERENCES nodes(id), kind TEXT NOT NULL, weight REAL DEFAULT 1, metadata_json TEXT)`).run()
    legacy.query(`INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', 'r')`).run()
    legacy.query(`INSERT INTO nodes (id, run_id, kind, key, label) VALUES (1, 1, 'unit', 'unit:a.ts', 'a.ts'), (2, 1, 'unit', 'unit:b.ts', 'b.ts')`).run()
    legacy.query(`INSERT INTO edges (run_id, from_node_id, to_node_id, kind) VALUES (1, 1, 2, 'imports')`).run()
    legacy.close()

    const db = openDb(dbPath)
    const row = db.query('SELECT confidence FROM edges WHERE from_node_id = 1').get() as { confidence: number }
    expect(row.confidence).toBe(1.0)
    db.close()
  })
})

// code-spider-l0m
describe('evidence finding linkage', () => {
  test('new databases have evidence.finding_id', () => {
    const db = openDb(join(root, '.code-spider', 'index.db'))
    const cols = db.query("PRAGMA table_info(evidence)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('finding_id')
    db.close()
  })

  test('legacy databases gain evidence.finding_id', () => {
    const dbPath = join(root, 'legacy-evidence.db')
    const legacy = new Database(dbPath, { create: true })
    legacy.query(`CREATE TABLE runs (id INTEGER PRIMARY KEY, started_at TEXT NOT NULL, completed_at TEXT, repo_root TEXT NOT NULL, repo_commit TEXT, tool_version TEXT)`).run()
    legacy.query(`CREATE TABLE nodes (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), kind TEXT NOT NULL, key TEXT NOT NULL, label TEXT NOT NULL, path TEXT, language TEXT, summary TEXT, score REAL DEFAULT 0, confidence REAL DEFAULT 0, metadata_json TEXT, UNIQUE(run_id, kind, key))`).run()
    legacy.query(`CREATE TABLE edges (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), from_node_id INTEGER NOT NULL, to_node_id INTEGER NOT NULL, kind TEXT NOT NULL, weight REAL DEFAULT 1, metadata_json TEXT)`).run()
    legacy.query(`CREATE TABLE evidence (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES runs(id), node_id INTEGER, edge_id INTEGER, kind TEXT NOT NULL, source TEXT NOT NULL, locator TEXT, snippet TEXT, score REAL DEFAULT 0)`).run()
    legacy.close()

    const db = openDb(dbPath)
    const cols = db.query("PRAGMA table_info(evidence)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('finding_id')
    db.close()
  })
})
