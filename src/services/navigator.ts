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
  // code-spider-0fy: 1 when the unit matches a configured entrypoint glob
  entrypoint: number | null
}

export interface NodeStats {
  loc: number
  churn: number
  recency: number  // days since last commit (999 = unknown)
}

export interface RiskSignals {
  diagnosticCount: number
  edgeCount: number
}

export interface EvidenceRow {
  // code-spider-azy: exposed so evidence can be pinned to investigations
  id: number
  kind: string
  source: string
  locator: string | null
  snippet: string | null
  score: number
}

export interface MarkdownContextRow {
  sectionKey: string
  sectionTitle: string
  sectionPath: string | null
  sectionSummary: string | null
  docKey: string
  docLabel: string
  docPath: string | null
  docSummary: string | null
}

export interface BeadsContextRow {
  issueKey: string
  issueId: string | null
  title: string
  summary: string | null
  status: string | null
  weight: number
}

// code-spider-0fy: entrypoint rides along on every node read. nodeSelect()
// table-qualifies every column expression, so callers that alias the nodes
// table use nodeSelect('n') instead of string-splitting on commas (which
// breaks inside json_extract).
const NODE_COLUMNS = ['id', 'kind', 'key', 'label', 'path', 'language', 'summary', 'score', 'confidence']

function nodeSelect(prefix = ''): string {
  const p = prefix === '' ? '' : `${prefix}.`
  const columns = NODE_COLUMNS.map(c => `${p}${c}`)
  columns.push(`json_extract(${p}metadata_json,'$.entrypoint') AS entrypoint`)
  return columns.join(',')
}

const NODE_SELECT = nodeSelect()

export class Navigator {
  constructor(private db: Database, private runId: number) {}

  static latestRunId(db: Database, repoRoot: string): number | null {
    const row = db.query<{ id: number }, string>(
      'SELECT id FROM runs WHERE repo_root=? AND completed_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get(repoRoot)
    return row?.id ?? null
  }

  // code-spider-47p
  static runExists(db: Database, repoRoot: string, runId: number): boolean {
    const row = db.query<{ id: number }, [number, string]>(
      'SELECT id FROM runs WHERE id=? AND repo_root=? AND completed_at IS NOT NULL'
    ).get(runId, repoRoot)
    return row !== null && row !== undefined
  }

  // code-spider-47p
  static listRunIds(db: Database, repoRoot: string, limit = 10): number[] {
    return db.query<{ id: number }, [string, number]>(
      'SELECT id FROM runs WHERE repo_root=? AND completed_at IS NOT NULL ORDER BY id DESC LIMIT ?'
    ).all(repoRoot, limit).map(row => row.id)
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
      'SELECT id, kind, source, locator, snippet, score FROM evidence WHERE run_id=? AND node_id=? ORDER BY score DESC LIMIT ?'
    ).all(this.runId, nodeId, limit)
  }

  getRiskSignals(nodeId: number): RiskSignals {
    const diagnosticRow = this.db.query<{ cnt: number }, [number, number]>(
      'SELECT COUNT(*) as cnt FROM diagnostics WHERE run_id=? AND node_id=?'
    ).get(this.runId, nodeId)

    const edgeRow = this.db.query<{ cnt: number }, [number, number, number]>(
      `SELECT COUNT(*) as cnt
       FROM edges
       WHERE run_id=? AND (from_node_id=? OR to_node_id=?)`
    ).get(this.runId, nodeId, nodeId)

    return {
      diagnosticCount: diagnosticRow?.cnt ?? 0,
      edgeCount: edgeRow?.cnt ?? 0,
    }
  }

  getGitContext(nodeId: number, limit = 3): EvidenceRow[] {
    return this.db.query<EvidenceRow, [number, number, number]>(
      `SELECT id, kind, source, locator, snippet, score
       FROM evidence
       WHERE run_id=? AND node_id=? AND kind='git'
       ORDER BY score DESC, id DESC
       LIMIT ?`
    ).all(this.runId, nodeId, limit)
  }

  getMarkdownContext(nodeId: number, limit = 5): MarkdownContextRow[] {
    return this.db.query<MarkdownContextRow, [number, number, number]>(
      `SELECT
         section.key AS sectionKey,
         section.label AS sectionTitle,
         section.path AS sectionPath,
         section.summary AS sectionSummary,
         doc.key AS docKey,
         doc.label AS docLabel,
         doc.path AS docPath,
         doc.summary AS docSummary
       FROM edges mention
       JOIN nodes section ON section.id = mention.from_node_id
       JOIN edges containment
         ON containment.run_id = mention.run_id
        AND containment.kind = 'contains'
        AND containment.to_node_id = section.id
       JOIN nodes doc ON doc.id = containment.from_node_id
       WHERE mention.run_id = ?
         AND mention.kind = 'mentions'
         AND mention.to_node_id = ?
         AND section.kind = 'doc_section'
         AND doc.kind = 'doc'
       ORDER BY doc.path ASC, section.label ASC
       LIMIT ?`
    ).all(this.runId, nodeId, limit)
  }

  getBeadsContext(nodeId: number, limit = 5): BeadsContextRow[] {
    return this.db.query<BeadsContextRow, [number, number, number]>(
      `SELECT
         issue.key AS issueKey,
         issue.path AS issueId,
         issue.label AS title,
         issue.summary AS summary,
         json_extract(issue.metadata_json, '$.status') AS status,
         edge.weight AS weight
       FROM edges edge
       JOIN nodes issue ON issue.id = edge.from_node_id
       WHERE edge.run_id = ?
         AND edge.kind = 'tracked-by'
         AND edge.to_node_id = ?
         AND issue.kind = 'issue'
       ORDER BY edge.weight DESC, issue.path ASC
       LIMIT ?`
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
          `SELECT ${nodeSelect('n')} FROM nodes n WHERE n.run_id=? AND n.kind='unit' AND n.path LIKE ? ORDER BY n.score DESC LIMIT ?`
        ).all(this.runId, `${zoneName}/%`, limit)
      }

      // "recent" means newest touched files first, so lower recency values sort first.
      const metricCol = sortBy === 'churn'
        ? 'churn'
        : sortBy === 'recent'
          ? 'recency'
          : 'loc'
      const sortDir = sortBy === 'recent' ? 'ASC' : 'DESC'
      return this.db.query<NodeRow, [number, string, number, string, number]>(
        `SELECT ${nodeSelect('n')}
         FROM nodes n
         LEFT JOIN stats s ON s.node_id=n.id AND s.run_id=? AND s.metric=?
         WHERE n.run_id=? AND n.kind='unit' AND n.path LIKE ?
         ORDER BY COALESCE(s.value, 999) ${sortDir} LIMIT ?`
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

  getRunInfo(): { id: number; repo_root: string; repo_commit: string | null; started_at: string } | null {
    return this.db.query<{ id: number; repo_root: string; repo_commit: string | null; started_at: string }, [number]>(
      'SELECT id, repo_root, repo_commit, started_at FROM runs WHERE id=?'
    ).get(this.runId) ?? null
  }
}
