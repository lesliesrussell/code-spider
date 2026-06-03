// code-spider-7ui
// code-spider-bik
import { debugLog } from './debug'

export function tryExec(cmd: string): string | null {
  try {
    const { execSync } = require('node:child_process')
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf8' }).trim()
  } catch (err) {
    debugLog('exec', `command failed: ${cmd}`, err)
    return null
  }
}
