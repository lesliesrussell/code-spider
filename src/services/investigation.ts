import { Database } from 'bun:sqlite'

export interface InvestigationDetail {
  id: number
  question: string
  status: string
  summary: string | null
  createdAt: string
  nodes: { key: string; label: string; kind: string; note: string | null }[]
}

export interface InvestigationSummary {
  id: number
  question: string
  status: string
  nodeCount: number
  createdAt: string
}

interface InvestigationRow {
  id: number
  run_id: number | null
  title: string
  question: string
  status: string
  summary: string | null
  created_at: string
  updated_at: string
}

interface InvNodeRow {
  key: string
  label: string
  kind: string
  note: string | null
}

export class InvestigationService {
  constructor(private db: Database) {}

  start(question: string, runId?: number): number {
    const now = new Date().toISOString()
    const title = question.slice(0, 80)
    this.db.prepare(
      `INSERT INTO investigations (run_id, title, question, status, summary, created_at, updated_at)
       VALUES (?, ?, ?, 'open', NULL, ?, ?)`
    ).run(runId ?? null, title, question, now, now)

    const row = this.db.query<{ id: number }, []>(
      `SELECT id FROM investigations ORDER BY id DESC LIMIT 1`
    ).get()
    return row?.id ?? 0
  }

  addNode(investigationId: number, nodeKey: string, runId: number, note?: string): void {
    // Look up node by key and runId
    const node = this.db.query<{ id: number }, [number, string]>(
      `SELECT id FROM nodes WHERE run_id=? AND key=? LIMIT 1`
    ).get(runId, nodeKey)

    if (!node) {
      throw new Error(`Node not found: ${nodeKey} (run #${runId})`)
    }

    // Insert or ignore (primary key constraint)
    this.db.prepare(
      `INSERT OR IGNORE INTO investigation_nodes (investigation_id, node_id, note) VALUES (?, ?, ?)`
    ).run(investigationId, node.id, note ?? null)

    // Update note if already exists
    if (note !== undefined) {
      this.db.prepare(
        `UPDATE investigation_nodes SET note=? WHERE investigation_id=? AND node_id=?`
      ).run(note, investigationId, node.id)
    }

    const now = new Date().toISOString()
    this.db.prepare(
      `UPDATE investigations SET updated_at=? WHERE id=?`
    ).run(now, investigationId)
  }

  addNote(investigationId: number, note: string): void {
    const existing = this.db.query<{ summary: string | null }, [number]>(
      `SELECT summary FROM investigations WHERE id=? LIMIT 1`
    ).get(investigationId)

    if (!existing) {
      throw new Error(`Investigation not found: ${investigationId}`)
    }

    const newSummary = existing.summary ? `${existing.summary}\n${note}` : note
    const now = new Date().toISOString()
    this.db.prepare(
      `UPDATE investigations SET summary=?, updated_at=? WHERE id=?`
    ).run(newSummary, now, investigationId)
  }

  show(investigationId: number): InvestigationDetail {
    const inv = this.db.query<InvestigationRow, [number]>(
      `SELECT * FROM investigations WHERE id=? LIMIT 1`
    ).get(investigationId)

    if (!inv) {
      throw new Error(`Investigation not found: ${investigationId}`)
    }

    const nodes = this.db.query<InvNodeRow, [number]>(
      `SELECT n.key, n.label, n.kind, inv_n.note
       FROM investigation_nodes inv_n
       JOIN nodes n ON n.id = inv_n.node_id
       WHERE inv_n.investigation_id=?`
    ).all(investigationId)

    return {
      id: inv.id,
      question: inv.question,
      status: inv.status,
      summary: inv.summary,
      createdAt: inv.created_at,
      nodes,
    }
  }

  list(): InvestigationSummary[] {
    const rows = this.db.query<InvestigationRow, []>(
      `SELECT * FROM investigations ORDER BY id DESC`
    ).all()

    return rows.map(inv => {
      const countRow = this.db.query<{ cnt: number }, [number]>(
        `SELECT COUNT(*) as cnt FROM investigation_nodes WHERE investigation_id=?`
      ).get(inv.id)
      return {
        id: inv.id,
        question: inv.question,
        status: inv.status,
        nodeCount: countRow?.cnt ?? 0,
        createdAt: inv.created_at,
      }
    })
  }
}
