import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema'

const REQUIRED_TABLES = new Set([
  'runs',
  'nodes',
  'edges',
  'evidence',
  'stats',
  'analyzers',
  'analyzer_runs',
  'symbols',
  'symbol_edges',
  'diagnostics',
  'investigations',
  'investigation_nodes',
  'investigation_evidence',
])

function needsInitialization(db: Database): boolean {
  const rows = db.query<{ name: string }, []>(
    `SELECT name FROM sqlite_master WHERE type='table'`
  ).all()
  const existing = new Set(rows.map(row => row.name))

  for (const table of REQUIRED_TABLES) {
    if (!existing.has(table)) {
      return true
    }
  }

  return false
}

function initializeSchema(db: Database): void {
  db.query('PRAGMA journal_mode=WAL;').run()
  for (const stmt of SCHEMA) {
    db.query(stmt).run()
  }
}

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.query('PRAGMA busy_timeout=5000;').run()
  db.query('PRAGMA foreign_keys=ON;').run()

  if (needsInitialization(db)) {
    initializeSchema(db)
  }

  return db
}
