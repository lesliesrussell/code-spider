import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs'
import { join, relative, extname, basename } from 'node:path'

export interface FileEntry {
  path: string      // absolute path
  relPath: string   // relative to repo root
  ext: string       // e.g. '.ts'
  language: string  // e.g. 'TypeScript'
  sizeBytes: number
}

export interface Zone {
  name: string        // top-level dir name
  path: string        // absolute path
  fileCount: number
  languages: string[] // dominant languages
}

export interface ManifestFile {
  path: string
  kind: string    // 'package.json' | 'go.mod' | 'Cargo.toml' | etc.
  language: string // inferred primary language
}

interface IgnoreConfig {
  dirs: string[]
  globs: string[]
}

interface IgnoreRules {
  dirNames: Set<string>
  filePatterns: RegExp[]
}

const DEFAULT_IGNORE_DIRS = [
  '.git', 'node_modules', 'dist', 'build', '.cache', 'coverage',
  '__pycache__', '.venv', 'venv', 'vendor', 'target', '.next', 'out', '.turbo',
  '.code-spider',
]

function stripInlineComment(line: string): string {
  const idx = line.indexOf(' #')
  return idx === -1 ? line : line.slice(0, idx)
}

function normalizeYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function loadIgnoreConfig(root: string): IgnoreConfig {
  const configPath = join(root, '.code-spider', 'config.yaml')
  if (!existsSync(configPath)) {
    return { dirs: [], globs: [] }
  }

  try {
    const text = readFileSync(configPath, 'utf8')
    const config: IgnoreConfig = { dirs: [], globs: [] }
    let inIgnoreSection = false
    let currentList: keyof IgnoreConfig | null = null

    for (const rawLine of text.split(/\r?\n/)) {
      const line = stripInlineComment(rawLine)
      const trimmed = line.trim()
      if (trimmed === '') continue

      if (!line.startsWith(' ') && trimmed === 'ignore:') {
        inIgnoreSection = true
        currentList = null
        continue
      }

      if (!inIgnoreSection) continue

      const listMatch = /^\s+(dirs|globs):\s*$/.exec(line)
      if (listMatch) {
        currentList = listMatch[1] as keyof IgnoreConfig
        continue
      }

      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (itemMatch && currentList !== null) {
        config[currentList].push(normalizeYamlScalar(itemMatch[1] ?? ''))
      }
    }

    return config
  } catch {
    return { dirs: [], globs: [] }
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

function buildIgnoreRules(root: string): IgnoreRules {
  const config = loadIgnoreConfig(root)
  const dirNames = new Set([...DEFAULT_IGNORE_DIRS, ...config.dirs])
  const filePatterns = config.globs
    .filter(Boolean)
    .map(globToRegExp)

  return { dirNames, filePatterns }
}

const EXT_LANGUAGE: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.go': 'Go',
  '.rs': 'Rust',
  '.zig': 'Zig',
  '.java': 'Java',
  '.rb': 'Ruby',
  '.php': 'PHP',
  '.cs': 'C#',
  '.cpp': 'C/C++',
  '.cc': 'C/C++',
  '.cxx': 'C/C++',
  '.c': 'C/C++',
  '.h': 'C/C++',
  '.hpp': 'C/C++',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.kts': 'Kotlin',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.zsh': 'Shell',
  '.md': 'Markdown',
  '.mdx': 'Markdown',
  '.json': 'JSON',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.toml': 'TOML',
  '.sql': 'SQL',
}

function detectLanguage(ext: string): string {
  return EXT_LANGUAGE[ext] ?? 'Other'
}

function shouldIgnoreFile(relPath: string, rules: IgnoreRules): boolean {
  const name = basename(relPath)
  return rules.filePatterns.some(pattern => pattern.test(relPath) || pattern.test(name))
}

function walkDir(dir: string, root: string, results: FileEntry[], rules: IgnoreRules): void {
  let entries: import('node:fs').Dirent<string>[]
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return
  }

  for (const entry of entries) {
    if (entry.isDirectory() && rules.dirNames.has(entry.name)) continue

    const fullPath = join(dir, entry.name)

    if (entry.isDirectory()) {
      walkDir(fullPath, root, results, rules)
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = statSync(fullPath).size
      } catch {
        // skip unreadable
      }
      const relPath = relative(root, fullPath)
      if (shouldIgnoreFile(relPath, rules)) continue
      const ext = extname(entry.name)
      results.push({
        path: fullPath,
        relPath,
        ext,
        language: detectLanguage(ext),
        sizeBytes: size,
      })
    }
  }
}

export class FilesystemAdapter {
  async walk(root: string): Promise<FileEntry[]> {
    const results: FileEntry[] = []
    const rules = buildIgnoreRules(root)
    walkDir(root, root, results, rules)
    return results
  }

  detectZones(files: FileEntry[], root: string): Zone[] {
    const zoneMap = new Map<string, { path: string; files: FileEntry[] }>()

    for (const file of files) {
      const parts = file.relPath.split('/')
      const topDir = parts[0]
      if (topDir === undefined || topDir === '') continue

      // Files directly at root have no top-level dir — skip them as zones
      if (parts.length < 2) continue

      if (!zoneMap.has(topDir)) {
        zoneMap.set(topDir, { path: join(root, topDir), files: [] })
      }
      zoneMap.get(topDir)!.files.push(file)
    }

    const zones: Zone[] = []
    for (const [name, { path, files }] of zoneMap) {
      if (files.length < 3) continue

      // Count language frequencies
      const langCount = new Map<string, number>()
      for (const f of files) {
        langCount.set(f.language, (langCount.get(f.language) ?? 0) + 1)
      }
      const languages = [...langCount.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([lang]) => lang)

      zones.push({ name, path, fileCount: files.length, languages })
    }

    return zones.sort((a, b) => b.fileCount - a.fileCount)
  }

  async detectManifests(root: string): Promise<ManifestFile[]> {
    const manifests: ManifestFile[] = []

    const knownManifests: Array<{ file: string; kind: string; language: string }> = [
      { file: 'package.json', kind: 'package.json', language: 'JavaScript/TypeScript' },
      { file: 'pyproject.toml', kind: 'pyproject.toml', language: 'Python' },
      { file: 'requirements.txt', kind: 'requirements.txt', language: 'Python' },
      { file: 'setup.py', kind: 'setup.py', language: 'Python' },
      { file: 'go.mod', kind: 'go.mod', language: 'Go' },
      { file: 'Cargo.toml', kind: 'Cargo.toml', language: 'Rust' },
      { file: 'build.zig', kind: 'build.zig', language: 'Zig' },
      { file: 'build.zig.zon', kind: 'build.zig.zon', language: 'Zig' },
      { file: 'pom.xml', kind: 'pom.xml', language: 'Java' },
      { file: 'build.gradle', kind: 'build.gradle', language: 'Java' },
      { file: 'Gemfile', kind: 'Gemfile', language: 'Ruby' },
      { file: 'composer.json', kind: 'composer.json', language: 'PHP' },
    ]

    for (const { file, kind, language } of knownManifests) {
      const fullPath = join(root, file)
      if (existsSync(fullPath)) {
        manifests.push({ path: fullPath, kind, language })
      }
    }

    // Check for *.csproj files
    try {
      const rootEntries = readdirSync(root, { withFileTypes: true, encoding: 'utf8' })
      for (const entry of rootEntries) {
        if (entry.isFile() && entry.name.endsWith('.csproj')) {
          manifests.push({
            path: join(root, entry.name),
            kind: entry.name,
            language: 'C#',
          })
        }
      }
    } catch {
      // ignore
    }

    return manifests
  }
}
