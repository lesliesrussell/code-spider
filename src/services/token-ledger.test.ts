import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { recordIngested, recordIngestedNodes, recordIngestedAllUnits, getIngested, resetLedger } from './token-ledger'

function seed(): Database {
  const db = new Database(':memory:')
  db.query('CREATE TABLE runs (id INTEGER PRIMARY KEY)').run()
  db.query('CREATE TABLE nodes (id INTEGER PRIMARY KEY, run_id INTEGER, kind TEXT, key TEXT)').run()
  db.query('CREATE TABLE stats (id INTEGER PRIMARY KEY, run_id INTEGER, node_id INTEGER, metric TEXT, value REAL)').run()
  db.query("INSERT INTO runs (id) VALUES (1)").run()
  db.query("INSERT INTO nodes (id, run_id, kind, key) VALUES (1,1,'unit','unit:a.ts'),(2,1,'unit','unit:b.ts')").run()
  db.query("INSERT INTO stats (run_id, node_id, metric, value) VALUES (1,1,'tokens',100),(1,2,'tokens',50)").run()
  return db
}

describe('TokenLedger', () => {
  afterEach(() => resetLedger())

  test('accumulates raw ingested tokens', () => {
    resetLedger()
    recordIngested(40)
    recordIngested(60)
    expect(getIngested()).toBe(100)
  })

  test('resets to zero', () => {
    recordIngested(10)
    resetLedger()
    expect(getIngested()).toBe(0)
  })

  test('sums tokens stat for given node keys', () => {
    resetLedger()
    const db = seed()
    recordIngestedNodes(db, 1, ['unit:a.ts', 'unit:b.ts'])
    expect(getIngested()).toBe(150)
  })

  test('ignores unknown keys and empty list', () => {
    resetLedger()
    const db = seed()
    recordIngestedNodes(db, 1, [])
    recordIngestedNodes(db, 1, ['unit:missing.ts'])
    expect(getIngested()).toBe(0)
  })

  test('sums tokens across all unit nodes in the run', () => {
    resetLedger()
    const db = seed()
    recordIngestedAllUnits(db, 1)
    expect(getIngested()).toBe(150)
  })
})
