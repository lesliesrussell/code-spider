// code-spider-7ui
export function tryExec(cmd: string): string | null {
  try {
    const { execSync } = require('node:child_process')
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}
