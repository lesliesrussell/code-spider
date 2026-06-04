// code-spider-89w
// Unit-level import extraction: the substrate for cycle detection,
// reachability, and architecture rules. Bun's transpiler scans import
// specifiers without typechecking; we resolve relative specifiers against
// the set of indexed units only — no filesystem probing, so the result is
// purely a function of (file contents, unit list).
import { join, dirname } from 'node:path'
import { debugLog } from '../utils/debug'

export interface ImportRecord {
  fromPath: string
  toPath: string
  // Static imports are certain; dynamic import() is a runtime decision the
  // graph can't prove, so it propagates doubt (see edges.confidence).
  confidence: number
}

const LOADERS: Record<string, 'ts' | 'tsx' | 'js' | 'jsx'> = {
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
}

const RESOLUTION_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx']

const DYNAMIC_IMPORT_CONFIDENCE = 0.5

function loaderFor(path: string): 'ts' | 'tsx' | 'js' | 'jsx' | undefined {
  const dot = path.lastIndexOf('.')
  if (dot === -1) return undefined
  return LOADERS[path.slice(dot)]
}

// Normalize a joined path to repo-relative posix form, rejecting escapes
// above the repo root.
function normalize(path: string): string | undefined {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return undefined
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join('/')
}

function resolveSpecifier(fromPath: string, specifier: string, units: Set<string>): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  const base = normalize(join(dirname(fromPath), specifier).replaceAll('\\', '/'))
  if (base === undefined) return undefined
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`
    if (units.has(candidate)) return candidate
  }
  return undefined
}

// code-spider-cii
// `import type { X } from './y'` and `export type { X } from './y'` never
// reach scanImports output. This regex pass catches the explicit forms;
// inline `{ type X }`-only imports can still slip through — a documented
// residual, not a silent one.
const TYPE_IMPORT_RE = /(?:import|export)\s+type\s[^'"]*?from\s*['"]([^'"]+)['"]/g

function scanTypeOnlyImports(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(TYPE_IMPORT_RE)) {
    const specifier = match[1]
    if (specifier !== undefined) specifiers.push(specifier)
  }
  return specifiers
}

export async function scanUnitImports(repoRoot: string, unitPaths: string[]): Promise<ImportRecord[]> {
  const units = new Set(unitPaths)
  // from\0to -> confidence; duplicates keep the strongest signal so a
  // file that imports a module both statically and dynamically reads as
  // statically reachable.
  const records = new Map<string, number>()

  for (const fromPath of [...unitPaths].sort()) {
    const loader = loaderFor(fromPath)
    if (loader === undefined) continue
    let imports: Array<{ path: string; kind: string }>
    try {
      // code-spider-cii: the transpiler rejects shebang lines (CLI
      // entrypoints have them), so blank the first line out while keeping
      // line offsets intact.
      let source = await Bun.file(join(repoRoot, fromPath)).text()
      if (source.startsWith('#!')) {
        source = source.replace(/^#![^\n]*/, '')
      }
      imports = new Bun.Transpiler({ loader }).scanImports(source)
      // code-spider-cii: scanImports erases type-only imports (they don't
      // survive transpilation), but for reachability a type-only-imported
      // file is live. Supplement with a syntactic pass.
      for (const specifier of scanTypeOnlyImports(source)) {
        imports.push({ path: specifier, kind: 'import-statement' })
      }
    } catch (err) {
      // Fail soft: a file the transpiler can't read or parse contributes no
      // edges; it must not poison the rest of the scan.
      debugLog('import-edges', `scan failed for ${fromPath}`, err)
      continue
    }
    for (const imp of imports) {
      const toPath = resolveSpecifier(fromPath, imp.path, units)
      if (toPath === undefined || toPath === fromPath) continue
      const confidence = imp.kind === 'dynamic-import' ? DYNAMIC_IMPORT_CONFIDENCE : 1
      const key = `${fromPath}\u0000${toPath}`
      const existing = records.get(key)
      if (existing === undefined || confidence > existing) {
        records.set(key, confidence)
      }
    }
  }

  return [...records.entries()]
    .map(([key, confidence]) => {
      const [fromPath, toPath] = key.split('\u0000') as [string, string]
      return { fromPath, toPath, confidence }
    })
    .sort((a, b) => a.fromPath.localeCompare(b.fromPath) || a.toPath.localeCompare(b.toPath))
}
