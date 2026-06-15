// code-spider-7ab
import type { PluginDiagnostic, PluginDiagnosticSeverity } from '../../language-plugin'

// clang-tidy / cppcheck report 1-based line and column; LSP PluginRange is
// 0-based. We have no token length, so end == start (a point range).
function pointRange(line1: number, col1: number): PluginDiagnostic['range'] {
  const line = Math.max(0, line1 - 1)
  const character = Math.max(0, col1 - 1)
  const position = { line, character }
  return { start: position, end: { ...position } }
}

function makeDiagnostic(
  severity: PluginDiagnosticSeverity,
  line1: string | undefined,
  col1: string | undefined,
  message: string | undefined,
  code: string | undefined,
): PluginDiagnostic {
  const diagnostic: PluginDiagnostic = {
    severity,
    message: (message ?? '').trim(),
    range: pointRange(Number(line1), Number(col1)),
  }
  if (code !== undefined) diagnostic.code = code
  return diagnostic
}

const CLANG_TIDY_SEVERITY: Record<string, PluginDiagnosticSeverity> = {
  error: 1,
  warning: 2,
}

// e.g. /repo/src/foo.c:42:5: warning: message text [check-name]
const CLANG_TIDY_LINE = /^(.+?):(\d+):(\d+):\s+(error|warning|note):\s+(.*?)(?:\s+\[([^\]]+)\])?$/

export function parseClangTidy(text: string): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = []
  for (const raw of text.split('\n')) {
    const match = CLANG_TIDY_LINE.exec(raw.trimEnd())
    if (match === null) continue
    const [, , line, column, severityName, message, code] = match
    // note: lines are context for the preceding finding — fold them in rather
    // than emitting standalone diagnostics. Leading notes with no parent drop.
    if (severityName === 'note') {
      const parent = diagnostics[diagnostics.length - 1]
      if (parent !== undefined) parent.message += `\nnote: ${(message ?? '').trim()}`
      continue
    }
    const severity = CLANG_TIDY_SEVERITY[severityName ?? '']
    if (severity === undefined) continue
    diagnostics.push(makeDiagnostic(severity, line, column, message, code))
  }
  return diagnostics
}

const CPPCHECK_SEVERITY: Record<string, PluginDiagnosticSeverity> = {
  error: 1,
  warning: 2,
  style: 3,
  performance: 3,
  portability: 3,
  information: 4,
}

// cppcheck is invoked with
// --template={file}:{line}:{column}: {severity}: {message} [{id}]
// so its output shares the clang-tidy line shape but with cppcheck severities.
const CPPCHECK_LINE = /^(.+?):(\d+):(\d+):\s+(\w+):\s+(.*?)(?:\s+\[([^\]]+)\])?$/

export function parseCppcheck(text: string): PluginDiagnostic[] {
  const diagnostics: PluginDiagnostic[] = []
  for (const raw of text.split('\n')) {
    const match = CPPCHECK_LINE.exec(raw.trimEnd())
    if (match === null) continue
    const [, , line, column, severityName, message, code] = match
    const severity = CPPCHECK_SEVERITY[severityName ?? '']
    if (severity === undefined) continue
    diagnostics.push(makeDiagnostic(severity, line, column, message, code))
  }
  return diagnostics
}
