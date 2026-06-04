// code-spider-9cg
// Symbol-level unused detection over the LSP reference data populated by
// the enricher (code-spider-0pi). Only symbols whose references were
// actually queried can be judged — refQuery metadata distinguishes "zero
// references" from "never asked", so the query budget can't manufacture
// false positives. Exportedness is a source-line check at the declaration:
// exported dead symbols are API debt (unused-export, medium confidence —
// LSP can miss dynamic access); internal ones are local dead code
// (unused-symbol, low). See docs/intelligence-suite-design.md.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import { debugLog } from '../utils/debug'

const TEST_OR_FIXTURE = /(\.test\.|\.spec\.)|(^|\/)(test|tests|__tests__|fixtures)\//
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/

interface SymbolRow {
  id: number
  symbol_key: string
  name: string
  path: string
  range_json: string | null
  selection_range_json: string | null
  metadata_json: string | null
}

export class SymbolUnusedAnalyzer {
  analyze(db: Database, runId: number): { findings: number } {
    purgeFindings(db, runId, { ruleId: 'unused-export' })
    purgeFindings(db, runId, { ruleId: 'unused-symbol' })

    const run = db.query('SELECT repo_root FROM runs WHERE id = ?').get(runId) as { repo_root: string } | null
    if (run === null) return { findings: 0 }

    const rows = db
      .query(
        `SELECT s.id, s.symbol_key, s.name, n.path, s.range_json, s.selection_range_json, s.metadata_json
         FROM symbols s JOIN nodes n ON s.node_id = n.id
         WHERE s.run_id = ? AND n.path IS NOT NULL
         ORDER BY n.path, s.name`
      )
      .all(runId) as SymbolRow[]

    const store = new FindingsStore(db, runId)
    const sourceCache = new Map<string, string[] | null>()
    const readLines = (path: string): string[] | null => {
      if (sourceCache.has(path)) return sourceCache.get(path)!
      let lines: string[] | null = null
      try {
        lines = readFileSync(join(run.repo_root, path), 'utf8').split('\n')
      } catch (err) {
        debugLog('symbol-unused', `cannot read ${path}`, err)
      }
      sourceCache.set(path, lines)
      return lines
    }

    let count = 0
    for (const row of rows) {
      if (TEST_OR_FIXTURE.test(row.path)) continue
      if (!IDENTIFIER.test(row.name)) continue
      const refQuery = parseRefQuery(row.metadata_json)
      if (refQuery === null || refQuery.externalRefs > 0) continue

      const startLine = declarationLine(row)
      const lineText = startLine !== null ? (readLines(row.path)?.[startLine] ?? '') : ''
      const exported = /\bexport\b/.test(lineText)

      store.add({
        ruleId: exported ? 'unused-export' : 'unused-symbol',
        category: 'reachability',
        severity: exported ? 'warning' : 'info',
        confidence: exported ? 'medium' : 'low',
        title: exported ? `Unused export: ${row.name}` : `Unused symbol: ${row.name}`,
        summary: `${row.name} in ${row.path} has no references beyond its declaration (LSP-verified)`,
        anchor: row.symbol_key,
        nodeKey: `unit:${row.path}`,
        locations: [{ path: row.path, ...(startLine !== null ? { line: startLine + 1 } : {}) }],
        metrics: { externalRefs: 0 },
        tags: ['symbols'],
      })
      count++
    }
    return { findings: count }
  }
}

function parseRefQuery(metadataJson: string | null): { externalRefs: number } | null {
  if (metadataJson === null) return null
  try {
    const metadata = JSON.parse(metadataJson) as { refQuery?: { externalRefs?: unknown } }
    const externalRefs = metadata.refQuery?.externalRefs
    return typeof externalRefs === 'number' ? { externalRefs } : null
  } catch {
    return null
  }
}

function declarationLine(row: SymbolRow): number | null {
  for (const json of [row.selection_range_json, row.range_json]) {
    if (json === null) continue
    try {
      const range = JSON.parse(json) as { start?: { line?: number } }
      if (typeof range.start?.line === 'number') return range.start.line
    } catch {
      // fall through
    }
  }
  return null
}
