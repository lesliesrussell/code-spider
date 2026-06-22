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

// code-spider-e32
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh'])

function scanShellSpecifiers(source: string): string[] {
  // Matches: optional leading whitespace, then 'source' or '.', then whitespace, then a path.
  // ^\s* in /gm mode anchors to line start — '#' at line start prevents match.
  const re = /^\s*(?:source|\.)\s+(['"]?)([^\s'"#]+)\1/gm
  const specifiers: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const spec = match[2]
    if (spec !== undefined) specifiers.push(spec)
  }
  return specifiers
}

// code-spider-ty9
// Shared specifier extraction: shebang-tolerant, type-only-supplemented,
// fail-soft. Returns every import specifier (relative AND bare) so both the
// edge builder and the manifest analyzer read imports the same way.
export async function scanFileSpecifiers(
  repoRoot: string,
  relPath: string
): Promise<Array<{ path: string; kind: string }>> {
  // code-spider-e32: shell source/. imports
  const dot = relPath.lastIndexOf('.')
  const ext = dot !== -1 ? relPath.slice(dot) : ''
  if (SHELL_EXTENSIONS.has(ext)) {
    try {
      const source = await Bun.file(join(repoRoot, relPath)).text()
      return scanShellSpecifiers(source).map(path => ({ path, kind: 'import-statement' }))
    } catch (err) {
      debugLog('import-edges', `shell scan failed for ${relPath}`, err)
      return []
    }
  }

  const loader = loaderFor(relPath)
  if (loader === undefined) return []
  try {
    // code-spider-cii: the transpiler rejects shebang lines (CLI
    // entrypoints have them), so blank the first line out while keeping
    // line offsets intact.
    let source = await Bun.file(join(repoRoot, relPath)).text()
    if (source.startsWith('#!')) {
      source = source.replace(/^#![^\n]*/, '')
    }
    const imports = new Bun.Transpiler({ loader }).scanImports(source)
    // code-spider-cii: scanImports erases type-only imports (they don't
    // survive transpilation), but for reachability a type-only-imported
    // file is live. Supplement with a syntactic pass.
    for (const specifier of scanTypeOnlyImports(source)) {
      imports.push({ path: specifier, kind: 'import-statement' })
    }
    return imports
  } catch (err) {
    // Fail soft: a file the transpiler can't read or parse contributes no
    // imports; it must not poison the rest of the scan.
    debugLog('import-edges', `scan failed for ${relPath}`, err)
    return []
  }
}

export async function scanUnitImports(repoRoot: string, unitPaths: string[]): Promise<ImportRecord[]> {
  const units = new Set(unitPaths)
  // from\0to -> confidence; duplicates keep the strongest signal so a
  // file that imports a module both statically and dynamically reads as
  // statically reachable.
  const records = new Map<string, number>()

  for (const fromPath of [...unitPaths].sort()) {
    const imports = await scanFileSpecifiers(repoRoot, fromPath)
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
