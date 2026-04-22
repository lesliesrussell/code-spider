import type { Database } from 'bun:sqlite'
import type { BeadsIssue } from '../adapters/beads'

interface TargetNodeRow {
  id: number
  key: string
  path: string | null
  kind: string
}

function summarizeIssue(issue: BeadsIssue): string | null {
  const text = issue.description?.trim() || issue.close_reason?.trim() || ''
  if (text === '') return null
  return text.slice(0, 500)
}

function extractNodeRefs(text: string): string[] {
  return [...text.matchAll(/\b(?:repo|zone|unit|flow):[A-Za-z0-9._\-\/]+\b/g)]
    .map(match => match[0])
}

function extractMentionPaths(text: string, candidates: string[]): string[] {
  const mentions: string[] = []
  for (const candidate of candidates) {
    if (candidate.length < 3) continue
    if (text.includes(candidate)) {
      mentions.push(candidate)
    }
  }
  return mentions
}

export interface BeadsContextResult {
  issuesAdded: number
  dependencyEdgesAdded: number
  trackingEdgesAdded: number
}

export class BeadsContextIndexer {
  run(db: Database, runId: number, issues: BeadsIssue[]): BeadsContextResult {
    if (issues.length === 0) {
      return { issuesAdded: 0, dependencyEdgesAdded: 0, trackingEdgesAdded: 0 }
    }

    const targetNodes = db.query<TargetNodeRow, [number]>(
      `SELECT id, key, path, kind
       FROM nodes
       WHERE run_id=? AND kind IN ('repo', 'zone', 'unit')`
    ).all(runId)
    const keyToNode = new Map(targetNodes.map(node => [node.key, node]))
    const pathToNode = new Map(
      targetNodes.flatMap(node => node.kind === 'unit' && node.path ? [[node.path, node]] : [])
    )
    const candidatePaths = [...pathToNode.keys()]

    const insertNode = db.prepare(
      `INSERT OR IGNORE INTO nodes (run_id, kind, key, label, path, language, summary, confidence, metadata_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    const insertEdge = db.prepare(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight, metadata_json)
       VALUES (?,?,?,?,?,?)`
    )
    const insertEvidence = db.prepare(
      `INSERT INTO evidence (run_id, node_id, edge_id, kind, source, locator, snippet, score)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    const getNodeId = db.prepare('SELECT id FROM nodes WHERE run_id=? AND kind=? AND key=?')

    let issuesAdded = 0
    let dependencyEdgesAdded = 0
    let trackingEdgesAdded = 0

    for (const issue of issues) {
      const issueKey = `issue:${issue.id}`
      insertNode.run(
        runId,
        'issue',
        issueKey,
        issue.title,
        issue.id,
        null,
        summarizeIssue(issue),
        issue.status === 'open' || issue.status === 'in_progress' ? 0.9 : 0.7,
        JSON.stringify({
          status: issue.status ?? 'unknown',
          priority: issue.priority ?? null,
          issueType: issue.issue_type ?? null,
          assignee: issue.assignee ?? null,
          owner: issue.owner ?? null,
          updatedAt: issue.updated_at ?? null,
        }),
      )
      issuesAdded++
    }

    for (const issue of issues) {
      const issueKey = `issue:${issue.id}`
      const issueNode = getNodeId.get(runId, 'issue', issueKey) as { id: number } | undefined
      if (issueNode === undefined) continue

      for (const dep of issue.dependencies ?? []) {
        const depKey = `issue:${dep.depends_on_id}`
        const depNode = getNodeId.get(runId, 'issue', depKey) as { id: number } | undefined
        if (depNode === undefined) continue
        insertEdge.run(
          runId,
          issueNode.id,
          depNode.id,
          'depends-on',
          1,
          JSON.stringify({ type: dep.type }),
        )
        dependencyEdgesAdded++
      }

      const searchableText = [
        issue.title,
        issue.description ?? '',
        issue.close_reason ?? '',
      ].join('\n')
      const explicitRefs = new Set<string>()
      for (const nodeRef of extractNodeRefs(searchableText)) {
        explicitRefs.add(nodeRef)
      }
      for (const mentionPath of extractMentionPaths(searchableText, candidatePaths)) {
        const node = pathToNode.get(mentionPath)
        if (node) explicitRefs.add(node.key)
      }

      for (const nodeRef of explicitRefs) {
        const target = keyToNode.get(nodeRef)
        if (target === undefined) continue
        const activeWeight = issue.status === 'open' || issue.status === 'in_progress' ? 2 : 1
        const edge = insertEdge.run(
          runId,
          issueNode.id,
          target.id,
          'tracked-by',
          activeWeight,
          JSON.stringify({ issueId: issue.id, status: issue.status ?? 'unknown' }),
        )
        insertEvidence.run(
          runId,
          target.id,
          Number(edge.lastInsertRowid),
          'beads',
          issue.id,
          issue.status ?? 'unknown',
          issue.title,
          activeWeight,
        )
        trackingEdgesAdded++
      }
    }

    return { issuesAdded, dependencyEdgesAdded, trackingEdgesAdded }
  }
}
