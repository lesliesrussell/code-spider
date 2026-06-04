// code-spider-cii
// Reachability over the unit import graph. Roots are config-flagged
// entrypoints (code-spider-0fy) plus implicit test roots — the test runner
// is an entrypoint nobody imports. Confidence propagates max-min: a unit's
// reachability is the strongest path from any root, where a path is as
// strong as its weakest edge. Unreached units become unused-file findings;
// weakly-reached units (dynamic-import-only paths) get low-confidence info
// findings instead of silently passing — uncertainty is reported, not
// rounded to reachable. unused-export/unused-symbol need symbol-level
// reference data and live in a follow-up bead.
// See docs/intelligence-suite-design.md.
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'

// Languages whose units participate in the import graph. Everything else
// (docs, config) is out of scope for reachability and never flagged.
const IMPORT_LANGUAGES = new Set(['TypeScript', 'JavaScript'])

const TEST_PATH = /(\.test\.|\.spec\.)|(^|\/)(test|tests|__tests__)\//

// code-spider-cii: never flag ambient declarations (tsc consumes them with
// no import) or fixture files (tests load them by path string).
const EXEMPT_PATH = /\.d\.ts$|(^|\/)fixtures\//

interface UnitRow {
  id: number
  path: string
  language: string | null
  // 1 = explicit config glob; 'inferred' = convention inference (code-spider-hma)
  entrypoint: number | string | null
}

export class ReachabilityAnalyzer {
  analyze(db: Database, runId: number): { findings: number; roots: number } {
    const units = db
      .query(
        `SELECT id, path, language, json_extract(metadata_json, '$.entrypoint') AS entrypoint
         FROM nodes WHERE run_id = ? AND kind = 'unit' AND path IS NOT NULL`
      )
      .all(runId) as UnitRow[]
    const inScope = units.filter(u => u.language !== null && IMPORT_LANGUAGES.has(u.language))

    const edges = db
      .query(
        `SELECT from_node_id AS f, to_node_id AS t, confidence AS c
         FROM edges WHERE run_id = ? AND kind = 'imports'`
      )
      .all(runId) as Array<{ f: number; t: number; c: number }>
    const adjacency = new Map<number, Array<{ to: number; confidence: number }>>()
    for (const e of edges) {
      let list = adjacency.get(e.f)
      if (list === undefined) {
        list = []
        adjacency.set(e.f, list)
      }
      list.push({ to: e.t, confidence: e.c })
    }

    // code-spider-hma: inferred entrypoints are roots too — conservative, so
    // convention-wired files never false-positive as unused.
    const isRoot = (u: UnitRow): boolean => u.entrypoint === 1 || u.entrypoint === 'inferred'
    const roots = inScope.filter(isRoot)
    const implicitRoots = inScope.filter(u => !isRoot(u) && TEST_PATH.test(u.path))

    purgeFindings(db, runId, { ruleId: 'unused-file' })

    // No explicit entrypoints: reachability is undefined, not "everything is
    // dead". Degrade to zero findings.
    if (roots.length === 0) {
      return { findings: 0, roots: 0 }
    }

    // Max-min propagation: process strongest-first so each node's final
    // reachability is fixed the first time it is settled (Dijkstra with
    // min() as path cost and max-extraction).
    const best = new Map<number, number>()
    const pending = new Map<number, number>()
    for (const root of [...roots, ...implicitRoots]) pending.set(root.id, 1)
    while (pending.size > 0) {
      let nodeId = -1
      let confidence = -1
      for (const [id, c] of pending) {
        if (c > confidence) {
          nodeId = id
          confidence = c
        }
      }
      pending.delete(nodeId)
      best.set(nodeId, confidence)
      for (const edge of adjacency.get(nodeId) ?? []) {
        if (best.has(edge.to)) continue
        const pathConfidence = Math.min(confidence, edge.confidence)
        const existing = pending.get(edge.to)
        if (existing === undefined || pathConfidence > existing) {
          pending.set(edge.to, pathConfidence)
        }
      }
    }

    const store = new FindingsStore(db, runId)
    let count = 0
    for (const unit of [...inScope].sort((a, b) => a.path.localeCompare(b.path))) {
      if (isRoot(unit) || TEST_PATH.test(unit.path) || EXEMPT_PATH.test(unit.path)) continue
      const reach = best.get(unit.id)
      if (reach !== undefined && reach >= 1) continue
      const weak = reach !== undefined
      store.add({
        ruleId: 'unused-file',
        category: 'reachability',
        severity: weak ? 'info' : 'warning',
        confidence: weak ? 'low' : 'high',
        title: weak
          ? `Possibly unused file: ${unit.path}`
          : `Unused file: ${unit.path}`,
        summary: weak
          ? `${unit.path} is only reachable through dynamic imports (path confidence ${reach}) from configured entrypoints`
          : `${unit.path} is not reachable from any configured entrypoint or test file`,
        anchor: unit.path,
        nodeKey: `unit:${unit.path}`,
        locations: [{ path: unit.path }],
        metrics: { reachConfidence: reach ?? 0 },
        tags: ['reachability'],
      })
      count++
    }

    return { findings: count, roots: roots.length }
  }
}
