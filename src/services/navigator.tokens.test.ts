import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { Navigator } from './navigator'

function seed(): Database {
  const db = new Database(':memory:')
  db.query('CREATE TABLE nodes (id INTEGER PRIMARY KEY, run_id INTEGER, kind TEXT, key TEXT)').run()
  db.query('CREATE TABLE stats (id INTEGER PRIMARY KEY, run_id INTEGER, node_id INTEGER, metric TEXT, value REAL)').run()
  db.query("INSERT INTO nodes (id, run_id, kind, key) VALUES (1,1,'unit','unit:a.ts')").run()
  db.query("INSERT INTO stats (run_id, node_id, metric, value) VALUES (1,1,'loc',10),(1,1,'tokens',120)").run()
  return db
}

describe('Navigator.getStats tokens', () => {
  test('reads the tokens stat (0 when absent)', () => {
    const db = seed()
    const nav = new Navigator(db, 1)
    expect(nav.getStats(1).tokens).toBe(120)
  })
})
