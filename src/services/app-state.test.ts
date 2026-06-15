import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { getActiveInvestigation, setActiveInvestigation, clearActiveInvestigation } from './app-state'

function db(): Database {
  const d = new Database(':memory:')
  d.query('CREATE TABLE app_state (key TEXT PRIMARY KEY, value TEXT)').run()
  return d
}

describe('active investigation state', () => {
  test('null when unset', () => {
    expect(getActiveInvestigation(db())).toBeNull()
  })

  test('round-trips a set value', () => {
    const d = db()
    setActiveInvestigation(d, 7)
    expect(getActiveInvestigation(d)).toBe(7)
  })

  test('clear removes it', () => {
    const d = db()
    setActiveInvestigation(d, 7)
    clearActiveInvestigation(d)
    expect(getActiveInvestigation(d)).toBeNull()
  })
})
