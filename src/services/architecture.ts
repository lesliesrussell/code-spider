// code-spider-ek5
// Declarative architecture policies over the import graph:
//   layers — ordered [outer, ..., inner]; earlier layers may import later
//     ones, never the reverse. A layer name N owns units whose path starts
//     with 'N/' or 'src/N/'.
//   rules — explicit from/to glob prohibitions (forbid-import).
// Violations carry the offending edge as graph evidence. Visibility rules
// (private-api-leak) need symbol-level data and wait on code-spider-0pi.
// See docs/intelligence-suite-design.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'

export interface ArchRule {
  from: string
  to: string
  kind: 'forbid-import'
}

export interface ArchitectureOptions {
  layers?: string[][]
  rules?: ArchRule[]
}

// intelligence.architecture from config.yaml; fail-soft to empty options.
export function loadArchitectureOptions(repoRoot: string): ArchitectureOptions {
  try {
    const parsed = Bun.YAML.parse(readFileSync(join(repoRoot, '.code-spider', 'config.yaml'), 'utf8')) as {
      intelligence?: { architecture?: { layers?: unknown; rules?: unknown } }
    } | null
    const raw = parsed?.intelligence?.architecture
    if (raw === undefined || raw === null) return {}
    const options: ArchitectureOptions = {}
    if (Array.isArray(raw.layers)) {
      const layers = raw.layers.filter(
        (layer): layer is string[] => Array.isArray(layer) && layer.every(name => typeof name === 'string')
      )
      if (layers.length > 0) options.layers = layers
    }
    if (Array.isArray(raw.rules)) {
      const rules: ArchRule[] = []
      for (const item of raw.rules) {
        if (typeof item !== 'object' || item === null) continue
        const candidate = item as Record<string, unknown>
        if (
          typeof candidate['from'] === 'string' &&
          typeof candidate['to'] === 'string' &&
          candidate['kind'] === 'forbid-import'
        ) {
          rules.push({ from: candidate['from'], to: candidate['to'], kind: 'forbid-import' })
        }
      }
      if (rules.length > 0) options.rules = rules
    }
    return options
  } catch {
    return {}
  }
}

interface EdgeRow {
  fromPath: string
  toPath: string
}

function layerOf(path: string, layerNames: string[]): number {
  for (let i = 0; i < layerNames.length; i++) {
    const name = layerNames[i]!
    if (path.startsWith(`${name}/`) || path.startsWith(`src/${name}/`)) return i
  }
  return -1
}

export class ArchitectureAnalyzer {
  analyze(db: Database, runId: number, options: ArchitectureOptions): { findings: number } {
    purgeFindings(db, runId, { category: 'architecture' })
    const hasLayers = options.layers !== undefined && options.layers.length > 0
    const hasRules = options.rules !== undefined && options.rules.length > 0
    if (!hasLayers && !hasRules) return { findings: 0 }

    const edges = db
      .query(
        `SELECT n1.path AS fromPath, n2.path AS toPath FROM edges e
         JOIN nodes n1 ON e.from_node_id = n1.id
         JOIN nodes n2 ON e.to_node_id = n2.id
         WHERE e.run_id = ? AND e.kind = 'imports'
           AND n1.kind = 'unit' AND n2.kind = 'unit'
           AND n1.path IS NOT NULL AND n2.path IS NOT NULL
         ORDER BY fromPath, toPath`
      )
      .all(runId) as EdgeRow[]

    const store = new FindingsStore(db, runId)
    let count = 0

    const emit = (
      ruleId: 'forbidden-dependency' | 'layering-violation',
      edge: EdgeRow,
      policy: string,
      summary: string
    ): void => {
      const finding = store.add({
        ruleId,
        category: 'architecture',
        severity: 'error',
        confidence: 'high',
        title: `${ruleId === 'layering-violation' ? 'Layering violation' : 'Forbidden dependency'}: ${edge.fromPath} -> ${edge.toPath}`,
        summary,
        anchor: `${edge.fromPath}->${edge.toPath}|${policy}`,
        nodeKey: `unit:${edge.fromPath}`,
        locations: [{ path: edge.fromPath }, { path: edge.toPath }],
        tags: ['architecture'],
      })
      store.addEvidence(finding.id, {
        kind: 'graph',
        source: 'imports',
        locator: `${edge.fromPath} -> ${edge.toPath}`,
      })
      count++
    }

    for (const rule of options.rules ?? []) {
      const fromGlob = new Bun.Glob(rule.from)
      const toGlob = new Bun.Glob(rule.to)
      for (const edge of edges) {
        if (!fromGlob.match(edge.fromPath) || !toGlob.match(edge.toPath)) continue
        emit(
          'forbidden-dependency',
          edge,
          `${rule.from}!>${rule.to}`,
          `${edge.fromPath} imports ${edge.toPath}, forbidden by rule ${rule.from} -> ${rule.to}`
        )
      }
    }

    for (const layerNames of options.layers ?? []) {
      for (const edge of edges) {
        const fromLayer = layerOf(edge.fromPath, layerNames)
        const toLayer = layerOf(edge.toPath, layerNames)
        if (fromLayer === -1 || toLayer === -1 || fromLayer <= toLayer) continue
        emit(
          'layering-violation',
          edge,
          layerNames.join('>'),
          `${edge.fromPath} (${layerNames[fromLayer]!}) imports ${edge.toPath} (${layerNames[toLayer]!}) against layer order ${layerNames.join(' -> ')}`
        )
      }
    }

    return { findings: count }
  }
}
