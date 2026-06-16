import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../db/init'
import { setActiveInvestigation } from '../services/app-state'
import { resetLedger, recordIngestedNodes } from '../services/token-ledger'
import { recordCommandEvent } from '../services/record-event'
import { TokenSavingsService } from '../services/token-savings'

// Simulates the dispatch flow without spawning the CLI: seed an index, mark an
// investigation active, run a "command" (record provenance + emit stdout),
// then assert the headline.
describe('token savings end-to-end', () => {
  test('an active investigation accrues positive savings', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cs-e2e-'))
    const db = openDb(join(dir, 'index.db'))
    db.query("INSERT INTO runs (id, started_at, repo_root, corpus_ingested_tokens) VALUES (1, 'now', ?, 4000)").run(dir)
    db.query("INSERT INTO nodes (id, run_id, kind, key, label) VALUES (1,1,'unit','unit:a.ts','a.ts')").run()
    db.query("INSERT INTO stats (run_id, node_id, metric, value) VALUES (1,1,'tokens',1200)").run()
    db.query("INSERT INTO investigations (id, title, question, status, created_at, updated_at) VALUES (1,'q','q','open','now','now')").run()

    setActiveInvestigation(db, 1)

    // command 1: show unit:a.ts
    resetLedger()
    recordIngestedNodes(db, 1, ['unit:a.ts'])
    recordCommandEvent(db, 1, 'show', 'short stdout line\n')

    const s = new TokenSavingsService(db).forInvestigation(1)
    expect(s.commandCount).toBe(1)
    expect(s.ingested).toBe(1200)
    expect(s.saved).toBeGreaterThan(1000)
    expect(s.naiveCeiling).toBe(4000)
  })
})
