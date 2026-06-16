import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { TokenSavingsService } from '../services/token-savings'

describe('overview corpus total', () => {
  test('TokenSavingsService.corpusTotal returns the run total', () => {
    const d = new Database(':memory:')
    d.query('CREATE TABLE runs (id INTEGER PRIMARY KEY, corpus_ingested_tokens INTEGER)').run()
    d.query('INSERT INTO runs (id, corpus_ingested_tokens) VALUES (1, 42000)').run()
    expect(new TokenSavingsService(d).corpusTotal()).toBe(42000)
  })
})
