import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema'

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

  // code-spider-xbf
  // Always run the schema: every statement is IF NOT EXISTS, so this is
  // idempotent and cheap — and it lets additions (new tables, new indexes)
  // apply to existing databases. The old needsInitialization() gate only
  // checked tables, so index additions never reached older DBs.
  initializeSchema(db)

  return db
}
