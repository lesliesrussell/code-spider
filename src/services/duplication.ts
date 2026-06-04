// code-spider-9kx
// Strict-mode duplication detection: exact token-sequence matching via
// windowed hashing. Comments and whitespace are not tokens, so formatting
// drift doesn't defeat detection, but any differing code token splits a
// match (normalized/semantic-lite modes are code-spider-5jd). Cross-file
// only in v1. See docs/intelligence-suite-design.md.
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import type { Database } from 'bun:sqlite'
import { FindingsStore, purgeFindings } from './findings'
import { debugLog } from '../utils/debug'

export interface Token {
  text: string
  line: number
}

const WORD = /[A-Za-z0-9_$]/

// Minimal TS/JS lexer for duplication purposes: strings (with escapes,
// naive template literals), comments stripped, identifiers/numbers as word
// tokens, everything else single-character punctuation.
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let line = 1
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]!
    if (ch === '\n') {
      line++
      i++
      continue
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i++
      continue
    }
    if (ch === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i++
      continue
    }
    if (ch === '/' && source[i + 1] === '*') {
      i += 2
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line++
        i++
      }
      i += 2
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i
      const startLine = line
      i++
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') i++
        else if (source[i] === '\n') line++
        i++
      }
      i++
      tokens.push({ text: source.slice(start, i), line: startLine })
      continue
    }
    if (WORD.test(ch)) {
      const start = i
      while (i < n && WORD.test(source[i]!)) i++
      tokens.push({ text: source.slice(start, i), line })
      continue
    }
    tokens.push({ text: ch, line })
    i++
  }
  return tokens
}

export type DuplicationMode = 'strict' | 'normalized'

export interface DuplicationOptions {
  minTokens?: number
  // strict: exact token text. normalized: string/number literals collapse to
  // placeholders, so literal-only differences still match. Identifier
  // normalization (semantic-lite) is out of scope for now.
  mode?: DuplicationMode
}

const DEFAULT_MIN_TOKENS = 40

// intelligence.duplication.min-tokens from config.yaml; fail-soft to the
// default. Mode selection (normalized/semantic-lite) is code-spider-5jd.
export function loadDuplicationOptions(repoRoot: string): DuplicationOptions {
  try {
    const configPath = join(repoRoot, '.code-spider', 'config.yaml')
    const parsed = Bun.YAML.parse(readFileSync(configPath, 'utf8')) as {
      intelligence?: { duplication?: { 'min-tokens'?: unknown; mode?: unknown } }
    } | null
    const minTokens = parsed?.intelligence?.duplication?.['min-tokens']
    const mode = parsed?.intelligence?.duplication?.['mode']
    const options: DuplicationOptions = {}
    if (typeof minTokens === 'number' && minTokens > 0) options.minTokens = minTokens
    if (mode === 'strict' || mode === 'normalized') options.mode = mode
    return options
  } catch {
    return {}
  }
}

interface FileTokens {
  path: string
  tokens: Token[]
  // Parallel to tokens: the text used for hashing under the active mode.
  hashTexts: string[]
}

// code-spider-5jd
function hashText(token: Token, mode: DuplicationMode): string {
  if (mode === 'strict') return token.text
  const first = token.text[0]!
  if (first === "'" || first === '"' || first === '`') return '\u0001str'
  if (first >= '0' && first <= '9') return '\u0001num'
  return token.text
}

interface Region {
  pathA: string
  pathB: string
  // token index ranges [start, end) in each file
  startA: number
  startB: number
  length: number
}

export class DuplicationAnalyzer {
  async analyze(db: Database, runId: number, options: DuplicationOptions = {}): Promise<{ findings: number }> {
    const minTokens = options.minTokens ?? DEFAULT_MIN_TOKENS
    const mode = options.mode ?? 'strict'
    const run = db.query('SELECT repo_root FROM runs WHERE id = ?').get(runId) as { repo_root: string } | null
    if (run === null) return { findings: 0 }

    const units = db
      .query(
        `SELECT path FROM nodes
         WHERE run_id = ? AND kind = 'unit' AND path IS NOT NULL
           AND language IN ('TypeScript', 'JavaScript')
         ORDER BY path`
      )
      .all(runId) as Array<{ path: string }>

    const files: FileTokens[] = []
    for (const unit of units) {
      try {
        const source = await Bun.file(join(run.repo_root, unit.path)).text()
        const tokens = tokenize(source)
        files.push({ path: unit.path, tokens, hashTexts: tokens.map(t => hashText(t, mode)) })
      } catch (err) {
        // Fail soft per file: unreadable units contribute nothing.
        debugLog('duplication', `tokenize failed for ${unit.path}`, err)
      }
    }

    purgeFindings(db, runId, { category: 'duplication' })
    const store = new FindingsStore(db, runId)
    let count = 0

    // Whole-file duplicates first; their members are excluded from region
    // search so each duplication is reported once at the strongest level.
    const wholeFileGroups = new Map<string, FileTokens[]>()
    for (const file of files) {
      if (file.tokens.length === 0) continue
      const hash = String(Bun.hash(file.hashTexts.join('\u0000')))
      const group = wholeFileGroups.get(hash)
      if (group === undefined) wholeFileGroups.set(hash, [file])
      else group.push(file)
    }
    const inWholeFileDup = new Set<string>()
    for (const group of wholeFileGroups.values()) {
      if (group.length < 2) continue
      const paths = group.map(f => f.path).sort()
      for (const p of paths) inWholeFileDup.add(p)
      store.add({
        ruleId: 'duplicate-file',
        category: 'duplication',
        severity: 'warning',
        confidence: mode === 'strict' ? 'high' : 'medium',
        title: `${paths.length} ${mode === 'strict' ? 'identical' : 'structurally identical'} files`,
        summary: `${mode === 'strict' ? 'Token-identical' : 'Structurally identical (literals normalized)'} files: ${paths.join(', ')}`,
        anchor: paths.join('|'),
        nodeKey: `unit:${paths[0]!}`,
        locations: paths.map(p => ({ path: p })),
        metrics: { files: paths.length, tokens: group[0]!.tokens.length },
        tags: ['duplication'],
      })
      count++
    }

    const regionFiles = files.filter(f => !inWholeFileDup.has(f.path) && f.tokens.length >= minTokens)
    const byPath = new Map(regionFiles.map(f => [f.path, f]))

    // code-spider-5jd
    // Pairwise regions group into clone classes by normalized content:
    // every distinct (path, start) occurrence of the same content is one
    // member. Rule precedence: spans zones -> cross-package-duplication;
    // 3+ files -> clone-class; else duplicate-region.
    interface Occurrence {
      path: string
      line: number
    }
    const classes = new Map<string, { occurrences: Map<string, Occurrence>; tokens: number; lines: number }>()
    for (const region of findRegions(regionFiles, minTokens)) {
      const fileA = byPath.get(region.pathA)!
      const fileB = byPath.get(region.pathB)!
      const content = fileA.hashTexts.slice(region.startA, region.startA + region.length).join('\u0000')
      const contentHash = String(Bun.hash(content))
      let entry = classes.get(contentHash)
      if (entry === undefined) {
        entry = { occurrences: new Map(), tokens: 0, lines: 0 }
        classes.set(contentHash, entry)
      }
      const startLineA = fileA.tokens[region.startA]!.line
      const endLineA = fileA.tokens[region.startA + region.length - 1]!.line
      const startLineB = fileB.tokens[region.startB]!.line
      entry.occurrences.set(`${region.pathA}:${region.startA}`, { path: region.pathA, line: startLineA })
      entry.occurrences.set(`${region.pathB}:${region.startB}`, { path: region.pathB, line: startLineB })
      entry.tokens = Math.max(entry.tokens, region.length)
      entry.lines = Math.max(entry.lines, endLineA - startLineA + 1)
    }

    const confidence = mode === 'strict' ? 'high' : 'medium'
    const sortedClasses = [...classes.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    for (const [contentHash, entry] of sortedClasses) {
      const locations = [...entry.occurrences.values()].sort(
        (a, b) => a.path.localeCompare(b.path) || a.line - b.line
      )
      const paths = [...new Set(locations.map(l => l.path))].sort()
      const zones = [...new Set(paths.map(p => p.split('/')[0]!))]
      const ruleId =
        zones.length >= 2 ? 'cross-package-duplication' : paths.length >= 3 ? 'clone-class' : 'duplicate-region'
      store.add({
        ruleId,
        category: 'duplication',
        severity: 'warning',
        confidence,
        title:
          ruleId === 'cross-package-duplication'
            ? `Cross-package duplication across ${zones.length} zones`
            : ruleId === 'clone-class'
              ? `Clone class across ${paths.length} files`
              : `Duplicated region: ${paths.join(' and ')}`,
        summary: `${entry.tokens} matching tokens (${mode} mode) in ${locations
          .map(l => `${l.path}:${l.line}`)
          .join(', ')}`,
        anchor: `${paths.join('|')}|${contentHash}`,
        nodeKey: `unit:${paths[0]!}`,
        locations,
        metrics: { tokens: entry.tokens, lines: entry.lines, files: paths.length, zones: zones.length },
        tags: ['duplication'],
      })
      count++
    }

    return { findings: count }
  }
}

// Windowed hashing: every minTokens-sized window is hashed; window-hash
// collisions across files become candidate matches; consecutive matched
// windows at a constant offset delta merge into one maximal region.
function findRegions(files: FileTokens[], minTokens: number): Region[] {
  const windowHits = new Map<string, Array<{ file: number; start: number }>>()
  for (let fi = 0; fi < files.length; fi++) {
    const tokens = files[fi]!.tokens
    for (let start = 0; start + minTokens <= tokens.length; start++) {
      const hash = String(Bun.hash(files[fi]!.hashTexts.slice(start, start + minTokens).join('\u0000')))
      const hits = windowHits.get(hash)
      if (hits === undefined) windowHits.set(hash, [{ file: fi, start }])
      else hits.push({ file: fi, start })
    }
  }

  // Matched window starts per (fileA, fileB, delta) — delta-constant runs of
  // consecutive starts collapse into single regions. delta = startA - startB,
  // so startB recovers from any startA in the group.
  const pairMatches = new Map<string, { a: number; b: number; delta: number; starts: number[] }>()
  for (const hits of windowHits.values()) {
    if (hits.length < 2) continue
    for (let x = 0; x < hits.length; x++) {
      for (let y = x + 1; y < hits.length; y++) {
        const first = hits[x]!
        const second = hits[y]!
        if (first.file === second.file) continue
        const [lo, hi] = first.file < second.file ? [first, second] : [second, first]
        const delta = lo.start - hi.start
        const key = `${lo.file}|${hi.file}|${delta}`
        const entry = pairMatches.get(key)
        if (entry === undefined) pairMatches.set(key, { a: lo.file, b: hi.file, delta, starts: [lo.start] })
        else entry.starts.push(lo.start)
      }
    }
  }

  const regions: Region[] = []
  for (const { a, b, delta, starts } of pairMatches.values()) {
    starts.sort((x, y) => x - y)
    let runStart = starts[0]!
    let prev = starts[0]!
    for (let i = 1; i <= starts.length; i++) {
      const current = starts[i]
      // Windows within one window-length extend the same region (adjacent or
      // overlapping); a gap larger than that starts a new region.
      if (current !== undefined && current <= prev + minTokens) {
        prev = current
        continue
      }
      regions.push({
        pathA: files[a]!.path,
        pathB: files[b]!.path,
        startA: runStart,
        startB: runStart - delta,
        length: prev - runStart + minTokens,
      })
      if (current !== undefined) {
        runStart = current
        prev = current
      }
    }
  }
  return regions.sort(
    (r1, r2) => r1.pathA.localeCompare(r2.pathA) || r1.pathB.localeCompare(r2.pathB) || r1.startA - r2.startA
  )
}
