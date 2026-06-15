// code-spider-ab9
// Reads token_events into the headline savings number for an investigation,
// plus the lifetime corpus total used as the naive ceiling.
import type { Database } from 'bun:sqlite'

export interface InvestigationSavings {
  investigationId: number
  ingested: number
  emitted: number
  saved: number
  commandCount: number
  naiveCeiling: number
}

export class TokenSavingsService {
  constructor(private db: Database) {}

  corpusTotal(): number {
    const row = this.db.query<{ t: number | null }, []>(
      'SELECT corpus_ingested_tokens AS t FROM runs ORDER BY id DESC LIMIT 1'
    ).get()
    return row?.t ?? 0
  }

  forInvestigation(investigationId: number): InvestigationSavings {
    const row = this.db.query<{ ingested: number | null; emitted: number | null; cnt: number }, [number]>(
      `SELECT SUM(ingested) AS ingested, SUM(emitted) AS emitted, COUNT(*) AS cnt
         FROM token_events WHERE investigation_id=?`
    ).get(investigationId)
    const ingested = row?.ingested ?? 0
    const emitted = row?.emitted ?? 0
    return {
      investigationId,
      ingested,
      emitted,
      saved: Math.max(0, ingested - emitted),
      commandCount: row?.cnt ?? 0,
      naiveCeiling: this.corpusTotal(),
    }
  }
}
