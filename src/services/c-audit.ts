// code-spider-zox
// C/C++ correctness audit: promotes high-severity clang-tidy / cppcheck
// diagnostics (captured during semantic indexing) into intelligence findings
// so they reach `intelligence scan`, fingerprints, and SARIF export. The deep
// path-sensitive checks (null deref, leak, UAF) are stronger than the
// structural suite for C/C++, so we surface them as first-class findings.
// See docs/c-cpp-analyzer-design.md.
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import type { FindingConfidence, FindingSeverity } from './findings'

// Only clang-tidy and cppcheck feed the audit (clangd is symbols/defs/refs).
const AUDIT_TOOLS = ['clang-tidy', 'cppcheck']

interface DiagnosticRow {
  severity: string
  code: string | null
  message: string
  range_json: string | null
  path: string | null
  node_key: string
  tool_name: string
}

interface Range {
  start?: { line?: number; character?: number }
}

// diagnostics store LSP severity strings; promote only the actionable ones.
const SEVERITY_TO_FINDING: Record<string, { severity: FindingSeverity; confidence: FindingConfidence }> = {
  error: { severity: 'error', confidence: 'high' },
  warning: { severity: 'warning', confidence: 'medium' },
}

export class CAuditAnalyzer {
  analyze(db: Database, runId: number): { findings: number } {
    const startedAt = Date.now()
    const result = this.detect(db, runId)
    this.recordTelemetry(db, runId, 'success', Date.now() - startedAt)
    return result
  }

  private detect(db: Database, runId: number): { findings: number } {
    const placeholders = AUDIT_TOOLS.map(() => '?').join(', ')
    const rows = db
      .query(
        `SELECT d.severity, d.code, d.message, d.range_json, n.path, n.key AS node_key, a.tool_name
         FROM diagnostics d
         JOIN nodes n ON n.id = d.node_id AND n.run_id = d.run_id
         JOIN analyzers a ON a.id = d.analyzer_id
         WHERE d.run_id = ? AND a.tool_name IN (${placeholders})
         ORDER BY n.path, d.id`
      )
      .all(runId, ...AUDIT_TOOLS) as DiagnosticRow[]

    purgeFindings(db, runId, { category: 'correctness' })
    const store = new FindingsStore(db, runId)
    let count = 0

    for (const row of rows) {
      const mapped = SEVERITY_TO_FINDING[row.severity]
      if (mapped === undefined) continue // info / hint are not promoted

      const ruleId = row.code ?? `${row.tool_name}-diagnostic`
      const path = row.path ?? row.node_key
      const { line, column } = this.position(row.range_json)
      // Anchor on the check + line (not persisted; feeds the fingerprint). A
      // structural symbol anchor would be more drift-stable, but the tool gives
      // us only a location — line keeps distinct findings distinct.
      const anchor = `L${line}`

      const finding = store.add({
        ruleId,
        category: 'correctness',
        severity: mapped.severity,
        confidence: mapped.confidence,
        title: ruleId,
        summary: row.message,
        anchor,
        nodeKey: row.node_key,
        locations: [{ path, line, column }],
        tags: [row.tool_name, 'c-audit'],
      })
      store.addEvidence(finding.id, {
        kind: 'diagnostic',
        source: row.tool_name,
        locator: `${path}:${line}:${column}`,
        snippet: row.message,
      })
      count++
    }

    return { findings: count }
  }

  // LSP ranges are 0-based; findings/locations report 1-based line/column.
  private position(rangeJson: string | null): { line: number; column: number } {
    if (rangeJson === null) return { line: 0, column: 0 }
    try {
      const range = JSON.parse(rangeJson) as Range
      return {
        line: (range.start?.line ?? 0) + 1,
        column: (range.start?.character ?? 0) + 1,
      }
    } catch {
      return { line: 0, column: 0 }
    }
  }

  // Conforms to the analyzer contract: executions land in analyzer_runs so
  // doctor/coverage tooling sees in-process analyzers like external ones.
  private recordTelemetry(db: Database, runId: number, status: string, durationMs: number): void {
    let analyzer = db
      .query(`SELECT id FROM analyzers WHERE run_id = ? AND tool_name = 'c-audit'`)
      .get(runId) as { id: number } | null
    if (analyzer === null) {
      db.query(
        `INSERT INTO analyzers (run_id, language, tool_name, tool_kind, available) VALUES (?, 'any', 'c-audit', 'quality', 1)`
      ).run(runId)
      analyzer = db
        .query(`SELECT id FROM analyzers WHERE run_id = ? AND tool_name = 'c-audit'`)
        .get(runId) as { id: number }
    }
    db.query(
      `INSERT INTO analyzer_runs (run_id, analyzer_id, language, capability, status, duration_ms)
       VALUES (?, ?, 'any', 'diagnostics', ?, ?)`
    ).run(runId, analyzer.id, status, durationMs)
  }
}
