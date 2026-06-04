// code-spider-p1d
// Hotspot scoring: weighted composite of complexity (loc proxy), import
// centrality, churn, duplication involvement, and cycle membership — each
// normalized to [0,1] by the run's max, so the composite is comparable
// within a run, not across repos. Consumes cycles/duplication findings, so
// it runs after those analyzers in the scan order. The existing per-node
// risk assessment in Exporter is untouched (backward compatible).
// See docs/intelligence-suite-design.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { FindingsStore } from './findings'

export interface HotspotWeights {
  complexity: number
  centrality: number
  churn: number
  duplication: number
  cycles: number
}

export interface HotspotOptions {
  weights?: HotspotWeights
}

const DEFAULT_WEIGHTS: HotspotWeights = {
  complexity: 0.3,
  centrality: 0.2,
  churn: 0.2,
  duplication: 0.15,
  cycles: 0.15,
}

// Hotspot semantics are code-oriented; docs and config never score.
const NON_CODE_LANGUAGES = ['Markdown', 'YAML', 'JSON', 'TOML', 'Other']

const HOTSPOT_THRESHOLD = 0.5
const OUTLIER_RATIO = 2 // signal >= 2x the run mean
const MIN_OUTLIER_LOC = 200
const MIN_HUB_DEGREE = 5

// intelligence.hotspots.weights from config.yaml; fail-soft to defaults.
export function loadHotspotOptions(repoRoot: string): HotspotOptions {
  try {
    const parsed = Bun.YAML.parse(readFileSync(join(repoRoot, '.code-spider', 'config.yaml'), 'utf8')) as {
      intelligence?: { hotspots?: { weights?: Record<string, unknown> } }
    } | null
    const raw = parsed?.intelligence?.hotspots?.weights
    if (raw === undefined || raw === null) return {}
    const weights = { ...DEFAULT_WEIGHTS }
    for (const key of Object.keys(DEFAULT_WEIGHTS) as Array<keyof HotspotWeights>) {
      const value = raw[key]
      if (typeof value === 'number' && value >= 0) weights[key] = value
    }
    return { weights }
  } catch {
    return {}
  }
}

interface UnitRow {
  id: number
  path: string
}

export class HotspotAnalyzer {
  analyze(db: Database, runId: number, options: HotspotOptions = {}): { findings: number } {
    const weights = options.weights ?? DEFAULT_WEIGHTS
    const units = db
      .query(
        `SELECT id, path FROM nodes
         WHERE run_id = ? AND kind = 'unit' AND path IS NOT NULL
           AND language IS NOT NULL AND language NOT IN (${NON_CODE_LANGUAGES.map(() => '?').join(',')})
         ORDER BY path`
      )
      .all(runId, ...NON_CODE_LANGUAGES) as UnitRow[]

    const stat = (metric: string): Map<number, number> => {
      const map = new Map<number, number>()
      for (const row of db
        .query(`SELECT node_id, value FROM stats WHERE run_id = ? AND metric = ?`)
        .all(runId, metric) as Array<{ node_id: number; value: number }>) {
        map.set(row.node_id, row.value)
      }
      return map
    }
    const loc = stat('loc')
    const churn = stat('churn')

    const degree = new Map<number, number>()
    for (const row of db
      .query(`SELECT from_node_id AS f, to_node_id AS t FROM edges WHERE run_id = ? AND kind = 'imports'`)
      .all(runId) as Array<{ f: number; t: number }>) {
      degree.set(row.f, (degree.get(row.f) ?? 0) + 1)
      degree.set(row.t, (degree.get(row.t) ?? 0) + 1)
    }

    // Per-path involvement counts from prior analyzer findings.
    const pathCounts = (category: string): Map<string, number> => {
      const map = new Map<string, number>()
      for (const row of db
        .query(`SELECT locations_json FROM findings WHERE run_id = ? AND category = ?`)
        .all(runId, category) as Array<{ locations_json: string }>) {
        for (const location of JSON.parse(row.locations_json) as Array<{ path: string }>) {
          map.set(location.path, (map.get(location.path) ?? 0) + 1)
        }
      }
      return map
    }
    const cycleCounts = pathCounts('cycles')
    const dupCounts = pathCounts('duplication')

    const max = (values: number[]): number => values.reduce((a, b) => Math.max(a, b), 0)
    const maxLoc = max(units.map(u => loc.get(u.id) ?? 0))
    const maxChurn = max(units.map(u => churn.get(u.id) ?? 0))
    const maxDegree = max(units.map(u => degree.get(u.id) ?? 0))
    const maxDup = max(units.map(u => dupCounts.get(u.path) ?? 0))
    const weightSum =
      weights.complexity + weights.centrality + weights.churn + weights.duplication + weights.cycles

    db.query(`DELETE FROM findings WHERE run_id = ? AND category = 'hotspots'`).run(runId)
    const store = new FindingsStore(db, runId)
    let count = 0

    const meanLoc = units.length > 0 ? units.reduce((s, u) => s + (loc.get(u.id) ?? 0), 0) / units.length : 0
    const meanDegree =
      units.length > 0 ? units.reduce((s, u) => s + (degree.get(u.id) ?? 0), 0) / units.length : 0

    for (const unit of units) {
      const unitLoc = loc.get(unit.id) ?? 0
      const unitChurn = churn.get(unit.id) ?? 0
      const unitDegree = degree.get(unit.id) ?? 0
      const components = {
        complexity: maxLoc > 0 ? unitLoc / maxLoc : 0,
        centrality: maxDegree > 0 ? unitDegree / maxDegree : 0,
        churn: maxChurn > 0 ? unitChurn / maxChurn : 0,
        duplication: maxDup > 0 ? (dupCounts.get(unit.path) ?? 0) / maxDup : 0,
        cycles: (cycleCounts.get(unit.path) ?? 0) > 0 ? 1 : 0,
      }
      const composite =
        weightSum > 0
          ? (weights.complexity * components.complexity +
              weights.centrality * components.centrality +
              weights.churn * components.churn +
              weights.duplication * components.duplication +
              weights.cycles * components.cycles) /
            weightSum
          : 0

      if (composite >= HOTSPOT_THRESHOLD) {
        const drivers = (Object.entries(components) as Array<[string, number]>)
          .filter(([, v]) => v >= 0.5)
          .map(([k]) => k)
        store.add({
          ruleId: 'hotspot',
          category: 'hotspots',
          severity: 'warning',
          confidence: 'medium',
          title: `Hotspot: ${unit.path}`,
          summary: `Composite risk ${composite.toFixed(2)} driven by ${drivers.join(', ') || 'multiple signals'}`,
          anchor: unit.path,
          nodeKey: `unit:${unit.path}`,
          locations: [{ path: unit.path }],
          metrics: { composite: Number(composite.toFixed(4)), ...components },
          tags: ['hotspot'],
        })
        count++
      }

      if (unitLoc >= MIN_OUTLIER_LOC && meanLoc > 0 && unitLoc >= OUTLIER_RATIO * meanLoc) {
        store.add({
          ruleId: 'complexity-outlier',
          category: 'hotspots',
          severity: 'info',
          confidence: 'medium',
          title: `Complexity outlier: ${unit.path}`,
          summary: `${unit.path} is ${unitLoc} loc, ${(unitLoc / meanLoc).toFixed(1)}x the run mean of ${Math.round(meanLoc)}`,
          anchor: unit.path,
          nodeKey: `unit:${unit.path}`,
          locations: [{ path: unit.path }],
          metrics: { loc: unitLoc, meanLoc: Number(meanLoc.toFixed(1)) },
          tags: ['hotspot'],
        })
        count++
      }

      if (unitDegree >= MIN_HUB_DEGREE && meanDegree > 0 && unitDegree >= OUTLIER_RATIO * meanDegree) {
        store.add({
          ruleId: 'high-centrality-risk',
          category: 'hotspots',
          severity: 'info',
          confidence: 'medium',
          title: `High-centrality hub: ${unit.path}`,
          summary: `${unit.path} touches ${unitDegree} import edges, ${(unitDegree / meanDegree).toFixed(1)}x the run mean`,
          anchor: unit.path,
          nodeKey: `unit:${unit.path}`,
          locations: [{ path: unit.path }],
          metrics: { degree: unitDegree, meanDegree: Number(meanDegree.toFixed(1)) },
          tags: ['hotspot'],
        })
        count++
      }
    }

    return { findings: count }
  }
}
