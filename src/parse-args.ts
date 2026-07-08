// code-spider-1iv
import type { CliContext } from './types'
import { resolve } from 'node:path'

export function parseArgs(argv: string[]): CliContext {
  const flags: Record<string, string | boolean> = {}
  const args: string[] = []
  let repoRoot = process.cwd()
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (arg === '--json') {
      json = true
      flags['json'] = true
    } else if (arg === '--repo') {
      const next = argv[++i]
      if (next !== undefined) {
        repoRoot = resolve(next)
        flags['repo'] = repoRoot
      }
    } else if (arg === '--db') {
      const next = argv[++i]
      if (next !== undefined) {
        flags['db'] = resolve(next)
      }
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (arg !== '') {
      args.push(arg)
    }
  }

  const dbOverride = typeof flags['db'] === 'string' ? flags['db'] : undefined
  const dbPath = dbOverride ?? resolve(repoRoot, '.code-spider', 'index.db')
  return { repoRoot, dbPath, json, args, flags }
}
