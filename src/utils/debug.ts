// code-spider-bik
// Env-gated trace channel for errors that are intentionally swallowed to keep
// degradation graceful. Default output is unchanged; set CODE_SPIDER_DEBUG=1
// to surface every suppressed failure on stderr.

function enabled(): boolean {
  const value = process.env['CODE_SPIDER_DEBUG']
  return value === '1' || value === 'true'
}

function formatDetail(error: unknown): string {
  if (error === undefined) return ''
  if (error instanceof Error) return error.message
  return String(error)
}

export function debugLog(scope: string, message: string, error?: unknown): void {
  if (!enabled()) return
  const detail = formatDetail(error)
  console.error(`[code-spider:${scope}] ${message}${detail === '' ? '' : `: ${detail}`}`)
}
