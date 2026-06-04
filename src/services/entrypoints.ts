// code-spider-0fy
// Explicit entrypoints from .code-spider/config.yaml. Reachability,
// inference (code-spider-hma), and architecture rules all key off the
// entrypoint flag stamped into unit node metadata at index time.
// v1 is explicit-only; framework inference layers on later with lower
// confidence. See docs/intelligence-suite-design.md.
import { join } from 'node:path'
import { loadUserConfigSection } from '../adapters/filesystem'
import { debugLog } from '../utils/debug'

export function loadEntrypointGlobs(repoRoot: string): string[] {
  return loadUserConfigSection(repoRoot, 'intelligence')['entrypoints'] ?? []
}

export function isEntrypoint(globs: string[], relPath: string): boolean {
  return globs.some(glob => new Bun.Glob(glob).match(relPath))
}

// code-spider-hma
// Convention-based inference, supplementing explicit config globs. Borrowed
// from FlowDetector's high-precision conventions, applied at index time:
//   - package.json bin/main/module targets
//   - shebang files (CLI entries nobody imports)
//   - file-based routing conventions (route.ts, routes.ts, page.tsx, ...)
// Inferred entries are marked 'inferred' in node metadata — explicit config
// always wins — and reachability treats them as roots so convention-wired
// files don't false-positive as unused.
const ROUTE_FILE_GLOBS = ['**/route.ts', '**/routes.ts', '**/route.tsx', '**/page.tsx', '**/routes.js']
const SCRIPT_EXTENSIONS = /\.(ts|tsx|js|jsx)$/

function normalizeManifestPath(value: string): string {
  return value.replace(/^\.\//, '')
}

export async function inferEntrypoints(repoRoot: string, unitPaths: string[]): Promise<Map<string, string>> {
  const inferred = new Map<string, string>()
  const units = new Set(unitPaths)

  // package.json bin / main / module
  try {
    const pkg = JSON.parse(await Bun.file(join(repoRoot, 'package.json')).text()) as {
      bin?: string | Record<string, string>
      main?: string
      module?: string
    }
    const binTargets = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})
    for (const target of binTargets) {
      const path = normalizeManifestPath(target)
      if (units.has(path)) inferred.set(path, 'package.json bin')
    }
    for (const [field, value] of [['main', pkg.main], ['module', pkg.module]] as const) {
      if (typeof value !== 'string') continue
      const path = normalizeManifestPath(value)
      if (units.has(path) && !inferred.has(path)) inferred.set(path, `package.json ${field}`)
    }
  } catch (err) {
    debugLog('entrypoints', 'no usable package.json for inference', err)
  }

  // route-file conventions
  const routeGlobs = ROUTE_FILE_GLOBS.map(g => new Bun.Glob(g))
  for (const path of unitPaths) {
    if (inferred.has(path)) continue
    if (routeGlobs.some(glob => glob.match(path))) inferred.set(path, 'route convention')
  }

  // shebang scripts
  for (const path of unitPaths) {
    if (inferred.has(path) || !SCRIPT_EXTENSIONS.test(path)) continue
    try {
      const head = await Bun.file(join(repoRoot, path)).slice(0, 2).text()
      if (head === '#!') inferred.set(path, 'shebang CLI')
    } catch (err) {
      debugLog('entrypoints', `cannot read ${path} for shebang check`, err)
    }
  }

  return inferred
}
