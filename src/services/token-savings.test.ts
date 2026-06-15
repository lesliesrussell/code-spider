import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TokenSavingsService } from './token-savings'

function db(): Database {
  const d = new Database(':memory:')
  d.query('CREATE TABLE runs (id INTEGER PRIMARY KEY, corpus_ingested_tokens INTEGER)').run()
  d.query(`CREATE TABLE token_events (id INTEGER PRIMARY KEY, run_id INTEGER, investigation_id INTEGER, command TEXT, ingested INTEGER, emitted INTEGER, ts INTEGER)`).run()
  d.query('INSERT INTO runs (id, corpus_ingested_tokens) VALUES (1, 9000)').run()
  d.query("INSERT INTO token_events (run_id, investigation_id, command, ingested, emitted, ts) VALUES (1,5,'show',1000,120,1),(1,5,'children',500,80,2),(1,6,'show',300,40,3)").run()
  return d
}

describe('TokenSavingsService', () => {
  test('sums savings for one investigation', () => {
    const svc = new TokenSavingsService(db())
    const s = svc.forInvestigation(5)
    expect(s.ingested).toBe(1500)
    expect(s.emitted).toBe(200)
    expect(s.saved).toBe(1300)
    expect(s.commandCount).toBe(2)
  })

  test('naive ceiling is the latest corpus total', () => {
    const svc = new TokenSavingsService(db())
    expect(svc.forInvestigation(5).naiveCeiling).toBe(9000)
  })

  test('zero for an investigation with no events', () => {
    const svc = new TokenSavingsService(db())
    const s = svc.forInvestigation(99)
    expect(s.saved).toBe(0)
    expect(s.commandCount).toBe(0)
  })

  test('corpusTotal reads the latest run', () => {
    const svc = new TokenSavingsService(db())
    expect(svc.corpusTotal()).toBe(9000)
  })
})
