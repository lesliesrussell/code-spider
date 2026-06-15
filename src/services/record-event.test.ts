import { describe, expect, test, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { recordCommandEvent } from './record-event'
import { recordIngested, resetLedger } from './token-ledger'

function db(): Database {
  const d = new Database(':memory:')
  d.query('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT)').run()
  d.query('CREATE TABLE runs (id INTEGER PRIMARY KEY)').run()
  d.query(`CREATE TABLE token_events (id INTEGER PRIMARY KEY, run_id INTEGER, investigation_id INTEGER, command TEXT, ingested INTEGER, emitted INTEGER, ts INTEGER)`).run()
  d.query('INSERT INTO runs (id) VALUES (1)').run()
  return d
}

afterEach(() => resetLedger())

describe('recordCommandEvent', () => {
  test('writes nothing when no active investigation', () => {
    const d = db()
    resetLedger(); recordIngested(500)
    recordCommandEvent(d, 1, 'show', 'a'.repeat(400))
    expect(d.query('SELECT COUNT(*) AS c FROM token_events').get()).toEqual({ c: 0 })
  })

  test('writes one event when an investigation is active', () => {
    const d = db()
    d.query("INSERT INTO app_state (key,value) VALUES ('active_investigation','5')").run()
    resetLedger(); recordIngested(500)
    recordCommandEvent(d, 1, 'show', 'a'.repeat(400)) // 400 chars prose => 100 tokens
    const row = d.query<{ investigation_id: number; ingested: number; emitted: number; command: string }, []>(
      'SELECT investigation_id, ingested, emitted, command FROM token_events'
    ).get()
    expect(row).toEqual({ investigation_id: 5, ingested: 500, emitted: 100, command: 'show' })
  })
})
