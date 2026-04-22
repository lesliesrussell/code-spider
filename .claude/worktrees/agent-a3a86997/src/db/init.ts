import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { SCHEMA } from './schema'

export function openDb(dbPath: string): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.query('PRAGMA journal_mode=WAL;').run()
  db.query('PRAGMA foreign_keys=ON;').run()
  for (const stmt of SCHEMA) {
    db.query(stmt).run()
  }
  return db
}
