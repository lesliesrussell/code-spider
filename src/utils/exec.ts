// code-spider-7ui
// code-spider-bik
import { debugLog } from './debug'

// code-spider-ijq
// PATH lookup without a subprocess or shell interpolation. The previous
// execSync(`which ${bin}`) interpolated registry-YAML-sourced names into a
// shell string — metacharacters broke detection (or executed).
export function commandExists(bin: string): boolean {
  if (bin === '') return false
  return Bun.which(bin) !== null
}

export function tryExec(cmd: string): string | null {
  try {
    const { execSync } = require('node:child_process')
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch (err) {
    debugLog('exec', `command failed: ${cmd}`, err)
    return null
  }
}
