// code-spider-ab9
// Post-command hook: if an investigation is active, persist one token_event
// using the ledger's ingested total and the captured stdout as emitted.
import type { Database } from 'bun:sqlite'
import { getActiveInvestigation } from './app-state'
import { getIngested } from './token-ledger'
import { RatioTokenCounter } from './token-counter'

const counter = new RatioTokenCounter()

export function recordCommandEvent(
  db: Database,
  runId: number,
  command: string,
  capturedStdout: string,
): void {
  const active = getActiveInvestigation(db)
  if (active === null) return
  const ingested = getIngested()
  const emitted = counter.count(capturedStdout, 'prose')
  db.query(
    `INSERT INTO token_events (run_id, investigation_id, command, ingested, emitted, ts)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(runId, active, command, ingested, emitted, Date.now())
}
