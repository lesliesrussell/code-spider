import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TokenSavingsService } from './token-savings'
import { renderTokenSavingsMd } from './exporter'

function db(): Database {
  const d = new Database(':memory:')
  d.query('CREATE TABLE runs (id INTEGER PRIMARY KEY, corpus_ingested_tokens INTEGER)').run()
  d.query('CREATE TABLE token_events (id INTEGER PRIMARY KEY, run_id INTEGER, investigation_id INTEGER, command TEXT, ingested INTEGER, emitted INTEGER, ts INTEGER)').run()
  d.query('INSERT INTO runs (id, corpus_ingested_tokens) VALUES (1, 5000)').run()
  d.query("INSERT INTO token_events (run_id, investigation_id, command, ingested, emitted, ts) VALUES (1,1,'show',800,100,1)").run()
  return d
}

describe('exporter savings fragment', () => {
  test('renderTokenSavingsMd includes saved total', () => {
    const s = new TokenSavingsService(db()).forInvestigation(1)
    const md = renderTokenSavingsMd(s)
    expect(md).toContain('Token Savings')
    expect(md).toContain('700')
  })

  test('returns empty string when no events', () => {
    const s = new TokenSavingsService(db()).forInvestigation(999)
    expect(renderTokenSavingsMd(s)).toBe('')
  })
})
