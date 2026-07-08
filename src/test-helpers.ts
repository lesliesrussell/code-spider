// code-spider-5jl
// Shared test scaffolding. In each test file:
//   import { makeTempRepo, cleanupTempDirs, captureLogs } from '../test-helpers'
//   afterEach(cleanupTempDirs)
// The afterEach must live in the test file — bun binds hooks registered
// during module evaluation to whichever file loaded the module first.
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const tempDirs: string[] = []

export function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

export function cleanupTempDirs(): void {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
}

export function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const originalLog = console.log
  console.log = (...args: unknown[]) => {
    lines.push(args.map(arg => String(arg)).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.log = originalLog
    },
  }
}

// Same shape as captureLogs, for stderr assertions.
export function captureErrors(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const originalError = console.error
  console.error = (...args: unknown[]) => {
    lines.push(args.map(arg => String(arg)).join(' '))
  }
  return {
    lines,
    restore: () => {
      console.error = originalError
    },
  }
}
