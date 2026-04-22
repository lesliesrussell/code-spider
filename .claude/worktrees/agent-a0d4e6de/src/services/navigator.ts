import { Database } from 'bun:sqlite'

export interface NodeRow {
  id: number
  kind: string
  key: string
  label: string
  path: string | null
  language: string | null
  summary: string | null
  score: number
  confidence: number
}

export interface NodeStats {
  loc: number
  churn: number
  recency: number  // days since last commit (999 = unknown)
}

export interface EvidenceRow {
  kind: string
  source: string
  locator: string | null
  snippet: string | null
  score: number
}

const NODE_SELECT = 'id,kind,key,label,path,language,summary,score,confidence'

export class Navigator {
  constructor(private db: Database, private runId: number) {}

  static latestRunId(db: Database, repoRoot: string): number | null {
    const row = db.query<{ id: number }, string>(
      'SELECT id FROM runs WHERE repo_root=? AND completed_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(repoRoot)
    return row?.id ?? null
  }

  getNode(key: string): NodeRow | null {
    return this.db.query<NodeRow, [number, string]>(
      `SELECT ${NODE_SELECT} FROM nodes WHERE run_id=? AND key=?`
    ).get(this.runId, key) ?? null
  }

  getStats(nodeId: number): NodeStats {
    const rows = this.db.query<{ metric: string; value: number }, [number, number]>(
      'SELECT metric, value FROM stats WHERE run_id=? AND node_id=?'
    ).all(this.runId, nodeId)

    let loc = 0, churn = 0, recency = 999
    for (const row of rows) {
      if (row.metric === 'loc') loc = row.value
      else if (row.metric === 'churn') churn = row.value
      else if (row.metric === 'recency') recency = row.value
    }
    return { loc, churn, recency }
  }

  getEvidence(nodeId: number, limit = 5): EvidenceRow[] {
    return this.db.query<EvidenceRow, [number, number, number]>(
      'SELECT kind, source, locator, snippet, score FROM evidence WHERE run_id=? AND node_id=? ORDER BY score DESC LIMIT ?'
    ).all(this.runId, nodeId, limit)
  }

  getChildren(
    key: string,
    sortBy: 'score' | 'churn' | 'loc' | 'recent' = 'score',
    limit = 20
  ): NodeRow[] {
    if (key === 'repo:.') {
      return this.db.query<NodeRow, [number, number]>(
        `SELECT ${NODE_SELECT} FROM nodes WHERE run_id=? AND kind='zone' ORDER BY score DESC LIMIT ?`
      ).all(this.runId, limit)
    }

    if (key.startsWith('zone:')) {
      const zoneName = key.slice('zone:'.length)
      if (sortBy === 'score') {
        return this.db.query<NodeRow, [number, string, number]>(
          `SELECT ${NODE_SELECT.split(',').map(c => `n.${c}`).join(',')} FROM nodes n WHERE n.run_id=? AND n.kind='unit' AND n.path LIKE ? ORDER BY n.score DESC LIMIT ?`
        ).all(this.runId, `${zoneName}/%`, limit)
      }

      // For non-score sorts, join stats
      const metricCol = sortBy === 'churn' ? 'churn' : 'loc'
      return this.db.query<NodeRow, [number, string, number, string, number]>(
        `SELECT ${NODE_SELECT.split(',').map(c => `n.${c}`).join(',')}
         FROM nodes n
         LEFT JOIN stats s ON s.node_id=n.id AND s.run_id=? AND s.metric=?
         WHERE n.run_id=? AND n.kind='unit' AND n.path LIKE ?
         ORDER BY COALESCE(s.value, 0) DESC LIMIT ?`
      ).all(this.runId, metricCol, this.runId, `${zoneName}/%`, limit) as NodeRow[]
    }

    // unit: or anything else — no children yet
    return []
  }

  getZones(limit = 20): NodeRow[] {
    return this.db.query<NodeRow, [number, number]>(
      `SELECT ${NODE_SELECT} FROM nodes WHERE run_id=? AND kind='zone' ORDER BY score DESC LIMIT ?`
    ).all(this.runId, limit)
  }

  getTopUnits(limit = 10): (NodeRow & NodeStats)[] {
    const units = this.db.query<NodeRow, [number, number]>(
      `SELECT ${NODE_SELECT} FROM nodes WHERE run_id=? AND kind='unit' ORDER BY score DESC LIMIT ?`
    ).all(this.runId, limit)

    return units.map(u => ({ ...u, ...this.getStats(u.id) }))
  }

  getLanguageSummary(): { language: string; fileCount: number; loc: number }[] {
    return this.db.query<{ language: string; fileCount: number; loc: number }, [number, number]>(
      `SELECT n.language, COUNT(*) as fileCount, COALESCE(SUM(s.value),0) as loc
       FROM nodes n
       LEFT JOIN stats s ON s.node_id=n.id AND s.metric='loc' AND s.run_id=?
       WHERE n.run_id=? AND n.kind='unit' AND n.language IS NOT NULL
       GROUP BY n.language ORDER BY loc DESC`
    ).all(this.runId, this.runId)
  }

  getRepoNode(): NodeRow | null {
    return this.db.query<NodeRow, [number]>(
      `SELECT ${NODE_SELECT} FROM nodes WHERE run_id=? AND kind='repo' LIMIT 1`
    ).get(this.runId) ?? null
  }

  getZoneFileCount(zoneName: string): number {
    const row = this.db.query<{ cnt: number }, [number, string]>(
      `SELECT COUNT(*) as cnt FROM nodes WHERE run_id=? AND kind='unit' AND path LIKE ?`
    ).get(this.runId, `${zoneName}/%`)
    return row?.cnt ?? 0
  }

  getManifests(limit = 10): { source: string; snippet: string | null }[] {
    return this.db.query<{ source: string; snippet: string | null }, [number, number]>(
      `SELECT source, snippet FROM evidence WHERE run_id=? AND kind='manifest' LIMIT ?`
    ).all(this.runId, limit)
  }

  getRunInfo(): { id: number; repo_commit: string | null; started_at: string } | null {
    return this.db.query<{ id: number; repo_commit: string | null; started_at: string }, [number]>(
      'SELECT id, repo_commit, started_at FROM runs WHERE id=?'
    ).get(this.runId) ?? null
  }
}
