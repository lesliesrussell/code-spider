// code-spider-q6b
// Cycle detection over the unit import graph. Tarjan SCC (iterative — repo
// import chains can be deep) projected at two granularities: units
// (circular-dependency) and zones (package-cycle). Findings are recomputed
// idempotently per run: same graph, same fingerprints. See
// docs/intelligence-suite-design.md.
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import type { FindingInput } from './findings'

// Iterative Tarjan. Returns only components with 2+ members (self-loops are
// trivial and ignored), members sorted ascending, components sorted by first
// member — fully deterministic for fingerprinting.
export function stronglyConnectedComponents(
  nodes: number[],
  edges: Array<[number, number]>
): number[][] {
  const adjacency = new Map<number, number[]>()
  for (const node of nodes) adjacency.set(node, [])
  for (const [from, to] of edges) {
    if (from === to) continue
    adjacency.get(from)?.push(to)
  }
  // Sorted neighbors make traversal order (and thus output order) stable
  // regardless of edge insertion order.
  for (const neighbors of adjacency.values()) neighbors.sort((a, b) => a - b)

  const index = new Map<number, number>()
  const lowlink = new Map<number, number>()
  const onStack = new Set<number>()
  const stack: number[] = []
  let counter = 0
  const components: number[][] = []

  for (const root of [...nodes].sort((a, b) => a - b)) {
    if (index.has(root)) continue
    // Explicit work stack: [node, neighborCursor]
    const work: Array<[number, number]> = [[root, 0]]
    while (work.length > 0) {
      const frame = work[work.length - 1]!
      const [node, cursor] = frame
      if (cursor === 0) {
        index.set(node, counter)
        lowlink.set(node, counter)
        counter++
        stack.push(node)
        onStack.add(node)
      }
      const neighbors = adjacency.get(node) ?? []
      let advanced = false
      for (let i = cursor; i < neighbors.length; i++) {
        const next = neighbors[i]!
        if (!index.has(next)) {
          frame[1] = i + 1
          work.push([next, 0])
          advanced = true
          break
        }
        if (onStack.has(next)) {
          lowlink.set(node, Math.min(lowlink.get(node)!, index.get(next)!))
        }
      }
      if (advanced) continue
      // Node finished: pop frame, fold lowlink into parent, emit root SCCs.
      work.pop()
      const parent = work[work.length - 1]
      if (parent !== undefined) {
        lowlink.set(parent[0], Math.min(lowlink.get(parent[0])!, lowlink.get(node)!))
      }
      if (lowlink.get(node) === index.get(node)) {
        const component: number[] = []
        while (true) {
          const popped = stack.pop()!
          onStack.delete(popped)
          component.push(popped)
          if (popped === node) break
        }
        if (component.length > 1) components.push(component.sort((a, b) => a - b))
      }
    }
  }

  return components.sort((a, b) => a[0]! - b[0]!)
}

interface UnitRow {
  id: number
  key: string
  path: string
}

export class CycleAnalyzer {
  // Recomputes cycle findings for the run. Deletes prior cycles findings
  // first so re-analysis is idempotent.
  analyze(db: Database, runId: number): { findings: number } {
    const startedAt = Date.now()
    const result = this.detect(db, runId)
    this.recordTelemetry(db, runId, 'success', Date.now() - startedAt)
    return result
  }

  private detect(db: Database, runId: number): { findings: number } {
    const units = db
      .query(`SELECT id, key, path FROM nodes WHERE run_id = ? AND kind = 'unit' AND path IS NOT NULL`)
      .all(runId) as UnitRow[]
    const unitById = new Map(units.map(u => [u.id, u]))
    const edges = db
      .query(
        `SELECT e.from_node_id AS f, e.to_node_id AS t FROM edges e
         JOIN nodes n1 ON e.from_node_id = n1.id
         JOIN nodes n2 ON e.to_node_id = n2.id
         WHERE e.run_id = ? AND e.kind = 'imports' AND n1.kind = 'unit' AND n2.kind = 'unit'`
      )
      .all(runId) as Array<{ f: number; t: number }>

    const churnByNode = new Map<number, number>()
    for (const row of db
      .query(`SELECT node_id, value FROM stats WHERE run_id = ? AND metric = 'churn'`)
      .all(runId) as Array<{ node_id: number; value: number }>) {
      churnByNode.set(row.node_id, row.value)
    }

    purgeFindings(db, runId, { category: 'cycles' })
    const store = new FindingsStore(db, runId)
    let count = 0

    const unitSccs = stronglyConnectedComponents(
      units.map(u => u.id),
      edges.map(e => [e.f, e.t])
    )
    for (const scc of unitSccs) {
      const memberIds = new Set(scc)
      const members = scc.map(id => unitById.get(id)!).sort((a, b) => a.path.localeCompare(b.path))
      const paths = members.map(m => m.path)
      const totalChurn = scc.reduce((sum, id) => sum + (churnByNode.get(id) ?? 0), 0)
      const finding = store.add(makeCycleFinding('circular-dependency', paths, { sccSize: scc.length, totalChurn }))
      // code-spider-l0m: the cycle's own import edges are its evidence.
      for (const edge of edges) {
        if (!memberIds.has(edge.f) || !memberIds.has(edge.t)) continue
        store.addEvidence(finding.id, {
          kind: 'graph',
          source: 'imports',
          locator: `${unitById.get(edge.f)!.path} -> ${unitById.get(edge.t)!.path}`,
        })
      }
      count++
    }

    // Zone projection: zone = first path segment (same convention as
    // Navigator's zone membership). A zone edge exists where any unit
    // import crosses zones.
    const zoneEdges = new Set<string>()
    for (const e of edges) {
      const fromZone = zoneOf(unitById.get(e.f)?.path)
      const toZone = zoneOf(unitById.get(e.t)?.path)
      if (fromZone === undefined || toZone === undefined || fromZone === toZone) continue
      zoneEdges.add(`${fromZone}\u0000${toZone}`)
    }
    const zoneNames = [...new Set([...zoneEdges].flatMap(z => z.split('\u0000')))].sort()
    const zoneIndex = new Map(zoneNames.map((z, i) => [z, i]))
    const zoneSccs = stronglyConnectedComponents(
      zoneNames.map((_, i) => i),
      [...zoneEdges].map(z => {
        const [from, to] = z.split('\u0000') as [string, string]
        return [zoneIndex.get(from)!, zoneIndex.get(to)!]
      })
    )
    for (const scc of zoneSccs) {
      const zones = scc.map(i => zoneNames[i]!).sort()
      store.add(makeCycleFinding('package-cycle', zones, { sccSize: scc.length, totalChurn: 0 }))
      count++
    }

    return { findings: count }
  }

  // Conforms to the analyzer contract: executions land in analyzer_runs so
  // doctor/coverage tooling sees in-process analyzers like external ones.
  private recordTelemetry(db: Database, runId: number, status: string, durationMs: number): void {
    let analyzer = db
      .query(`SELECT id FROM analyzers WHERE run_id = ? AND tool_name = 'cycles'`)
      .get(runId) as { id: number } | null
    if (analyzer === null) {
      db.query(
        `INSERT INTO analyzers (run_id, language, tool_name, tool_kind, available) VALUES (?, 'any', 'cycles', 'structural', 1)`
      ).run(runId)
      analyzer = db
        .query(`SELECT id FROM analyzers WHERE run_id = ? AND tool_name = 'cycles'`)
        .get(runId) as { id: number }
    }
    db.query(
      `INSERT INTO analyzer_runs (run_id, analyzer_id, language, capability, status, duration_ms)
       VALUES (?, ?, 'any', 'diagnostics', ?, ?)`
    ).run(runId, analyzer.id, status, durationMs)
  }
}

function zoneOf(path: string | undefined): string | undefined {
  if (path === undefined) return undefined
  const slash = path.indexOf('/')
  return slash === -1 ? undefined : path.slice(0, slash)
}

function makeCycleFinding(
  ruleId: 'circular-dependency' | 'package-cycle',
  members: string[],
  metrics: { sccSize: number; totalChurn: number }
): FindingInput {
  const shown = members.slice(0, 5).join(', ') + (members.length > 5 ? `, +${members.length - 5} more` : '')
  const noun = ruleId === 'package-cycle' ? 'zones' : 'units'
  return {
    ruleId,
    category: 'cycles',
    severity: 'warning',
    confidence: 'high',
    title: `${ruleId === 'package-cycle' ? 'Package cycle' : 'Circular dependency'} among ${members.length} ${noun}`,
    summary: `Cycle members: ${shown}`,
    anchor: members.join('|'),
    nodeKey: ruleId === 'package-cycle' ? `zone:${members[0]!}` : `unit:${members[0]!}`,
    locations: ruleId === 'package-cycle' ? members.map(z => ({ path: z })) : members.map(p => ({ path: p })),
    metrics,
    tags: ['cycle'],
  }
}
