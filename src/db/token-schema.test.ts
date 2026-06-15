import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './init'

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cs-tok-'))
  return openDb(join(dir, 'index.db'))
}

describe('token-savings schema', () => {
  test('token_events table exists with expected columns', () => {
    const db = freshDb()
    const cols = db.query("PRAGMA table_info(token_events)").all() as Array<{ name: string }>
    const names = cols.map(c => c.name)
    expect(names).toEqual(
      expect.arrayContaining(['id', 'run_id', 'investigation_id', 'command', 'ingested', 'emitted', 'ts'])
    )
  })

  test('app_state key/value table exists', () => {
    const db = freshDb()
    const cols = db.query("PRAGMA table_info(app_state)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toEqual(expect.arrayContaining(['key', 'value']))
  })

  test('runs has corpus_ingested_tokens column', () => {
    const db = freshDb()
    const cols = db.query("PRAGMA table_info(runs)").all() as Array<{ name: string }>
    expect(cols.map(c => c.name)).toContain('corpus_ingested_tokens')
  })
})
