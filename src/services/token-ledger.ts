// code-spider-ab9
// Per-process accumulator of "ingested" provenance: the token-size of the
// source/evidence a command's answer rested on (what the cloud would have had
// to read). One CLI invocation = one process = one ledger.
import type { Database } from 'bun:sqlite'

let ingested = 0

export function resetLedger(): void {
  ingested = 0
}

export function recordIngested(tokens: number): void {
  if (tokens > 0) ingested += tokens
}

export function getIngested(): number {
  return Math.round(ingested)
}

// Sum the stored `tokens` stat for the given node keys in a run.
export function recordIngestedNodes(db: Database, runId: number, nodeKeys: string[]): void {
  if (nodeKeys.length === 0) return
  const placeholders = nodeKeys.map(() => '?').join(',')
  const rows = db.query<{ value: number }, unknown[]>(
    `SELECT s.value FROM stats s
       JOIN nodes n ON n.id = s.node_id
      WHERE s.run_id = ? AND s.metric = 'tokens' AND n.run_id = ? AND n.key IN (${placeholders})`
  ).all(runId, runId, ...nodeKeys)
  for (const r of rows) ingested += r.value
}

// Sum the `tokens` stat across every unit node in a run (for whole-corpus
// analyzers like `intelligence scan`).
export function recordIngestedAllUnits(db: Database, runId: number): void {
  const row = db.query<{ total: number | null }, [number]>(
    `SELECT SUM(s.value) AS total FROM stats s
       JOIN nodes n ON n.id = s.node_id
      WHERE s.run_id = ? AND s.metric = 'tokens' AND n.kind = 'unit'`
  ).get(runId)
  if (row?.total) ingested += row.total
}
