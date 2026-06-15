// code-spider-ua1
import { existsSync as fsExistsSync, readdirSync as fsReaddirSync } from 'node:fs'
import { join } from 'node:path'
import type { PluginDiagnostic } from '../../language-plugin'
import { parseClangTidy, parseCppcheck } from './cpp-diagnostics'

// clang-tidy prints diagnostics to stdout; cppcheck to stderr. Both are
// normalized by the parsers in ./cpp-diagnostics.

export function buildClangTidyArgs(filePath: string, compileDbDir?: string): string[] {
  const args = [filePath, '--quiet']
  if (compileDbDir !== undefined) args.push('-p', compileDbDir)
  return args
}

// Mirror of parseCppcheck's expected line shape — keep the two in lockstep.
const CPPCHECK_TEMPLATE = '{file}:{line}:{column}: {severity}: {message} [{id}]'

export function buildCppcheckArgs(filePath: string): string[] {
  return [
    filePath,
    '--quiet',
    '--enable=warning,performance,portability',
    `--template=${CPPCHECK_TEMPLATE}`,
  ]
}

export interface CompileDbDeps {
  existsSync: (path: string) => boolean
  readdirSync: (path: string) => string[]
}

const FIXED_BUILD_DIRS = ['.', 'build', 'out']

// Locate a compile_commands.json so clang-tidy/clangd get accurate flags.
// Searches the repo root, common build directories, and any cmake-build-*
// directory. Returns the containing directory, or undefined when absent
// (graceful degradation: clang-tidy then runs best-effort without -p).
export function findCompileDb(
  repoRoot: string,
  deps: CompileDbDeps = { existsSync: fsExistsSync, readdirSync: fsReaddirSync },
): string | undefined {
  const candidates = [...FIXED_BUILD_DIRS]
  let entries: string[] = []
  try {
    entries = deps.readdirSync(repoRoot)
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.startsWith('cmake-build') && !candidates.includes(entry)) candidates.push(entry)
  }

  for (const rel of candidates) {
    const dir = rel === '.' ? repoRoot : join(repoRoot, rel)
    if (deps.existsSync(join(dir, 'compile_commands.json'))) return dir
  }
  return undefined
}

// clang-tidy emits diagnostics on stdout, cppcheck on stderr. Route each tool
// to the right stream and parser; unknown tools yield nothing (fail soft).
export function parseToolOutput(tool: string, stdout: string, stderr: string): PluginDiagnostic[] {
  if (tool === 'clang-tidy') return parseClangTidy(stdout)
  if (tool === 'cppcheck') return parseCppcheck(stderr)
  return []
}
