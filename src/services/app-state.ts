// code-spider-ab9
// CLI session state in the index db. The active investigation id is what the
// command instrumentation attributes token_events to; commands run with none
// active record nothing.
import type { Database } from 'bun:sqlite'

const ACTIVE_KEY = 'active_investigation'

export function getActiveInvestigation(db: Database): number | null {
  const row = db.query<{ value: string }, [string]>(
    'SELECT value FROM app_state WHERE key=?'
  ).get(ACTIVE_KEY)
  if (!row) return null
  const n = parseInt(row.value, 10)
  return Number.isNaN(n) ? null : n
}

export function setActiveInvestigation(db: Database, id: number): void {
  db.query(
    `INSERT INTO app_state (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(ACTIVE_KEY, String(id))
}

export function clearActiveInvestigation(db: Database): void {
  db.query('DELETE FROM app_state WHERE key=?').run(ACTIVE_KEY)
}
