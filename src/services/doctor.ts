import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import type { AnalyzerCapability, AnalyzerRegistryDocument, RegistryLanguage } from '../analyzer-registry'
import { BuiltinLanguagePluginRegistry } from '../language-plugin-registry'
import { openDb } from '../db/init'
// code-spider-c6v
import { buildIgnoreRules, shouldIgnoreFile } from '../adapters/filesystem'
// code-spider-bik
import { debugLog } from '../utils/debug'
// code-spider-ijq
import { commandExists } from '../utils/exec'

export type CheckStatus = 'pass' | 'warn' | 'fail'

// code-spider-wa3
// Doctor scopes narrow the report to one concern:
//   semantic — per-language analyzer readiness and last-run coverage
//   repo     — environment tooling, database, context enrichers
//   perf     — repo size and database health
export type DoctorScope = 'semantic' | 'repo' | 'perf'

// code-spider-wa3
export function isDoctorScope(value: string): value is DoctorScope {
  return value === 'semantic' || value === 'repo' || value === 'perf'
}

export interface Check {
  name: string
  status: CheckStatus
  message: string
  remedy?: string
}

export interface FidelityReport {
  structural: boolean
  hotspot: boolean
  flowHeuristics: boolean
  // code-spider-h25
  // Semantic capabilities are tri-state. 'pass' = exercised and succeeded in
  // the last run; 'fail' = exercised but produced nothing, or no analyzer is
  // available; 'warn' = an analyzer is available but the last run never
  // exercised it (e.g. a structural-only index, no --semantic). 'warn' must NOT
  // be read as "works" — it means "unverified this run".
  symbolNavigation: CheckStatus
  semanticRefs: CheckStatus
  diagnostics: CheckStatus
}

export interface DoctorReport {
  repoRoot: string
  // code-spider-wa3
  scope: DoctorScope | null
  dbExists: boolean
  lastRunId: number | null
  detectedLanguages: string[]
  selectedAnalyzers: Array<{
    language: string
    analyzerId: string
    tool: string
    available: boolean
    capabilities: AnalyzerCapability[]
  }>
  selectedPlugins: Array<{
    language: string
    pluginId: string
    available: boolean
    capabilities: string[]
    details?: string
  }>
  lastRunCoverage: Array<{
    capability: AnalyzerCapability
    mode: 'sweep' | 'on-demand'
    succeeded: boolean
    successCount: number
    attemptedCount: number
    statuses: Record<string, number>
  }>
  checks: Check[]
  fidelity: FidelityReport
  contextEnrichers: Array<{
    name: 'git' | 'markdown' | 'beads'
    available: boolean
    observed: boolean
    details: string
  }>
  // code-spider-2ak
  // Actionable next steps derived from fidelity warn/fail states and failing
  // check remedies. Present in --json so agents don't have to interpret
  // tri-state values to know what to do next.
  recommendations: string[]
}

interface RunRow {
  id: number
  started_at: string
  completed_at: string | null
}

interface CountRow {
  count: number
}

interface AnalyzerRunCoverageRow {
  capability: AnalyzerCapability
  status: string
  count: number
}

function coverageModeForCapability(capability: AnalyzerCapability): 'sweep' | 'on-demand' {
  if (capability === 'refs') return 'on-demand'
  return 'sweep'
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim()
  } catch (err) {
    // code-spider-bik
    debugLog('doctor', `command failed: ${cmd}`, err)
    return null
  }
}

function checkGit(repoRoot: string): Check {
  const out = tryExec(`git -C ${repoRoot} rev-parse HEAD`)
  if (out !== null) {
    return { name: 'git', status: 'pass', message: `HEAD: ${out.slice(0, 7)}` }
  }
  return {
    name: 'git',
    status: 'fail',
    message: 'not found or not a git repository',
    remedy: 'Install git and ensure this directory is a git repository',
  }
}

function checkRg(): Check {
  const out = tryExec('rg --version')
  if (out !== null) {
    const version = out.split('\n')[0] ?? 'ripgrep'
    return { name: 'rg', status: 'pass', message: version }
  }
  return {
    name: 'rg',
    status: 'warn',
    message: 'not found',
    remedy: 'Install ripgrep: https://github.com/BurntSushi/ripgrep',
  }
}

// code-spider-ok8
// Bounds the doctor's repo walk. Language detection only needs file names, so
// the walk is cheap — but truncation can hide languages living deep in large
// repos, so it is logged when it happens.
const MAX_WALK_ENTRIES = 20000

function walkRepoFiles(root: string, maxEntries = MAX_WALK_ENTRIES): string[] {
  const results: string[] = []
  const queue = ['']
  // code-spider-c6v
  const rules = buildIgnoreRules(root)

  while (queue.length > 0 && results.length < maxEntries) {
    const relDir = queue.shift()
    if (relDir === undefined) break
    const fullDir = relDir === '' ? root : join(root, relDir)

    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(fullDir, { withFileTypes: true, encoding: 'utf8' })
    } catch (err) {
      // code-spider-bik
      debugLog('doctor', `failed to read dir ${fullDir}`, err)
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // code-spider-c6v
        if (rules.dirNames.has(entry.name)) continue
        const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        queue.push(childRel)
      } else if (entry.isFile()) {
        const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        // code-spider-c6v
        if (shouldIgnoreFile(childRel, rules)) continue
        results.push(childRel)
        if (results.length >= maxEntries) break
      }
    }
  }

  // code-spider-ok8
  if (results.length >= maxEntries) {
    debugLog('doctor', `repo walk truncated at ${maxEntries} files — language detection may be incomplete`)
  }

  return results
}

function detectLanguages(
  repoRoot: string,
  registry: AnalyzerRegistryDocument,
  plugins: BuiltinLanguagePluginRegistry,
): RegistryLanguage[] {
  const files = walkRepoFiles(repoRoot)
  const detected = plugins.detectLanguages(repoRoot, files)
  return detected.flatMap(entry => {
    const language = registry.languages.find(candidate => candidate.id === entry.languageId)
    return language === undefined ? [] : [language]
  })
}

function hasMarkdownFiles(repoRoot: string): boolean {
  return walkRepoFiles(repoRoot).some(file => file.endsWith('.md') || file.endsWith('.mdx'))
}

function toolCheckName(language: string, analyzerId: string): string {
  return `${language}:${analyzerId}`
}

function checkSelectedAnalyzers(
  repoRoot: string,
  languages: RegistryLanguage[],
  plugins: BuiltinLanguagePluginRegistry,
): {
  checks: Check[]
  selectedAnalyzers: DoctorReport['selectedAnalyzers']
  capabilities: Set<AnalyzerCapability>
} {
  const checks: Check[] = []
  const selectedAnalyzers: DoctorReport['selectedAnalyzers'] = []
  const capabilities = new Set<AnalyzerCapability>()

  for (const language of languages) {
    const plugin = plugins.getByLanguage(language.id)
    const analyzers = plugin?.describeAnalyzers(repoRoot, language.id) ?? []

    if (analyzers.length === 0) {
      checks.push({
        name: `${language.id}:registry`,
        status: 'warn',
        message: `${language.display_name}: no eligible analyzers for this repo`,
      })
      continue
    }

    for (const analyzer of analyzers) {
      checks.push({
        name: toolCheckName(language.id, analyzer.analyzerId),
        status: analyzer.available ? 'pass' : 'warn',
        message: `${language.display_name}: ${analyzer.tool}${analyzer.available ? ' available' : ' not found'}`,
      })

      selectedAnalyzers.push({
        language: language.id,
        analyzerId: analyzer.analyzerId,
        tool: analyzer.tool,
        available: analyzer.available,
        capabilities: analyzer.capabilities,
      })
    }

    for (const analyzer of analyzers) {
      if (!analyzer.available) continue
      for (const capability of analyzer.capabilities) {
        capabilities.add(capability)
      }
    }
  }

  return { checks, selectedAnalyzers, capabilities }
}

function checkPlugins(
  repoRoot: string,
  languages: RegistryLanguage[],
  plugins: BuiltinLanguagePluginRegistry,
): DoctorReport['selectedPlugins'] {
  return languages.flatMap(language => {
    const plugin = plugins.getByLanguage(language.id)
    if (plugin === undefined) return []
    const health = plugin.health(repoRoot)
    const capabilityStatus = plugin.capabilityStatus(repoRoot)
    const capabilities = Object.entries(capabilityStatus)
      .filter(([, status]) => status.supported)
      .map(([capability]) => capability)
    return [{
      language: language.id,
      pluginId: plugin.id,
      available: health.available,
      capabilities,
      details: health.details,
    }]
  })
}

function checkDatabase(dbPath: string): { check: Check; db: Database | null; lastRunId: number | null; lastRunDate: string | null; fileCount: number | null } {
  const dbExists = existsSync(dbPath)
  if (!dbExists) {
    return {
      check: { name: 'database', status: 'warn', message: 'no index yet — run: code-spider index' },
      db: null,
      lastRunId: null,
      lastRunDate: null,
      fileCount: null,
    }
  }

  let db: Database | null = null
  try {
    db = openDb(dbPath)
    const row = db.query<RunRow, []>(
      'SELECT id, started_at, completed_at FROM runs WHERE completed_at IS NOT NULL ORDER BY id DESC LIMIT 1'
    ).get()

    if (row === null || row === undefined) {
      return {
        check: { name: 'database', status: 'warn', message: 'database exists but no completed runs yet' },
        db,
        lastRunId: null,
        lastRunDate: null,
        fileCount: null,
      }
    }

    const countRow = db.query<CountRow, [number]>(
      "SELECT COUNT(*) as count FROM nodes WHERE run_id=? AND kind='unit'"
    ).get(row.id)

    const fileCount = countRow?.count ?? 0
    const dateStr = row.started_at.slice(0, 10)

    return {
      check: {
        name: 'database',
        status: 'pass',
        message: `Run #${row.id} · ${dateStr} · ${fileCount} files indexed`,
      },
      db,
      lastRunId: row.id,
      lastRunDate: dateStr,
      fileCount,
    }
  } catch (err) {
    // code-spider-bik
    debugLog('doctor', 'failed to read database', err)
    // code-spider-jew
    const detail = err instanceof Error ? err.message : String(err)
    if (isCorruptionError(detail)) {
      return {
        check: {
          name: 'database',
          status: 'fail',
          message: `database is corrupted (${detail})`,
          remedy: 'Delete .code-spider/index.db* and re-run: code-spider index',
        },
        db,
        lastRunId: null,
        lastRunDate: null,
        fileCount: null,
      }
    }
    return {
      check: {
        name: 'database',
        status: 'warn',
        message: `database exists but could not be read (${detail})`,
      },
      db,
      lastRunId: null,
      lastRunDate: null,
      fileCount: null,
    }
  }
}

// code-spider-jew
// SQLite corruption signatures — a corrupted index is not recoverable by
// retrying; the only remedy is a reindex.
function isCorruptionError(message: string): boolean {
  const lowered = message.toLowerCase()
  return ['malformed', 'not a database', 'invalid rootpage', 'database disk image'].some(
    signature => lowered.includes(signature)
  )
}

function checkRepoSize(_repoRoot: string, db: Database | null, lastRunId: number | null): Check {
  if (db !== null && lastRunId !== null) {
    const row = db.query<CountRow, [number]>(
      "SELECT COUNT(*) as count FROM nodes WHERE run_id=? AND kind='unit'"
    ).get(lastRunId)
    const count = row?.count ?? 0
    if (count > 50000) {
      return {
        name: 'repo-size',
        status: 'warn',
        message: `${count} files indexed — large repo, analysis may be slow`,
        // code-spider-xbf
        // No --incremental flag exists yet (tracked: code-spider-oun); only
        // recommend what the tool can actually do today.
        remedy: 'Ignore caches and generated dirs via .code-spider/config.yaml ignore: section to shrink the index',
      }
    }
    return { name: 'repo-size', status: 'pass', message: `${count} files indexed` }
  }
  // No DB — skip
  return { name: 'repo-size', status: 'pass', message: 'skipped (no index)' }
}

function summarizeLastRunCoverage(db: Database | null, lastRunId: number | null): DoctorReport['lastRunCoverage'] {
  if (db === null || lastRunId === null) return []

  const rows = db.query<AnalyzerRunCoverageRow, [number]>(
    `SELECT capability, status, COUNT(*) as count
     FROM analyzer_runs
     WHERE run_id=?
     GROUP BY capability, status
     ORDER BY capability, status`
  ).all(lastRunId)

  const byCapability = new Map<AnalyzerCapability, {
    attemptedCount: number
    successCount: number
    statuses: Record<string, number>
  }>()

  for (const row of rows) {
    const current = byCapability.get(row.capability) ?? {
      attemptedCount: 0,
      successCount: 0,
      statuses: {},
    }
    current.attemptedCount += row.count
    current.statuses[row.status] = row.count
    if (row.status === 'success') {
      current.successCount += row.count
    }
    byCapability.set(row.capability, current)
  }

  return [...byCapability.entries()].map(([capability, summary]) => ({
    capability,
    mode: coverageModeForCapability(capability),
    succeeded: summary.successCount > 0,
    successCount: summary.successCount,
    attemptedCount: summary.attemptedCount,
    statuses: summary.statuses,
  }))
}

// code-spider-h25
// Report a semantic capability's true state from the LAST RUN, not from static
// tool availability. If the run exercised it, trust the result; if it didn't,
// say 'warn' (available but unverified) rather than claiming success.
function semanticFidelity(
  coverage: DoctorReport['lastRunCoverage'],
  capabilities: AnalyzerCapability[],
  availableCapabilities: Set<AnalyzerCapability>,
): CheckStatus {
  const exercised = coverage.filter(item => capabilities.includes(item.capability))
  if (exercised.length > 0) {
    return exercised.some(item => item.succeeded) ? 'pass' : 'fail'
  }
  return capabilities.some(capability => availableCapabilities.has(capability)) ? 'warn' : 'fail'
}

function summarizeContextEnrichers(
  repoRoot: string,
  db: Database | null,
  lastRunId: number | null,
  gitAvailable: boolean,
): DoctorReport['contextEnrichers'] {
  const markdownAvailable = hasMarkdownFiles(repoRoot)
  // code-spider-ok8
  // Distinguish "no beads workspace" from "workspace present but bd not on
  // PATH" — the latter must not read as "beads unused".
  const beadsWorkspace = existsSync(join(repoRoot, '.beads'))
  const bdOnPath = beadsWorkspace && tryExec('bd --version') !== null
  const beadsAvailable = beadsWorkspace && bdOnPath
  const beadsUnavailableDetails = beadsWorkspace
    ? '.beads workspace found but bd is not on PATH'
    : 'no beads workspace'

  if (db === null || lastRunId === null) {
    return [
      {
        name: 'git',
        available: gitAvailable,
        observed: false,
        details: gitAvailable ? 'no completed run yet' : 'git unavailable',
      },
      {
        name: 'markdown',
        available: markdownAvailable,
        observed: false,
        details: markdownAvailable ? 'no completed run yet' : 'no markdown files detected',
      },
      {
        name: 'beads',
        available: beadsAvailable,
        observed: false,
        // code-spider-ok8
        details: beadsAvailable ? 'no completed run yet' : beadsUnavailableDetails,
      },
    ]
  }

  const gitEvidence = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM evidence
     WHERE run_id=? AND kind='git'`
  ).get(lastRunId)?.count ?? 0
  const cochangeEdges = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM edges
     WHERE run_id=? AND kind='changed-with'`
  ).get(lastRunId)?.count ?? 0
  const docs = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM nodes
     WHERE run_id=? AND kind='doc'`
  ).get(lastRunId)?.count ?? 0
  const sections = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM nodes
     WHERE run_id=? AND kind='doc_section'`
  ).get(lastRunId)?.count ?? 0
  const mentions = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM edges
     WHERE run_id=? AND kind='mentions'`
  ).get(lastRunId)?.count ?? 0
  const issues = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM nodes
     WHERE run_id=? AND kind='issue'`
  ).get(lastRunId)?.count ?? 0
  const trackedBy = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM edges
     WHERE run_id=? AND kind='tracked-by'`
  ).get(lastRunId)?.count ?? 0
  const issueDeps = db.query<CountRow, [number]>(
    `SELECT COUNT(*) as count
     FROM edges
     WHERE run_id=? AND kind='depends-on'`
  ).get(lastRunId)?.count ?? 0

  return [
    {
      name: 'git',
      available: gitAvailable,
      observed: gitEvidence > 0 || cochangeEdges > 0,
      details: `evidence:${gitEvidence}, cochange:${cochangeEdges}`,
    },
    {
      name: 'markdown',
      available: markdownAvailable,
      observed: docs > 0 || sections > 0 || mentions > 0,
      details: `docs:${docs}, sections:${sections}, mentions:${mentions}`,
    },
    {
      name: 'beads',
      available: beadsAvailable,
      observed: issues > 0 || trackedBy > 0 || issueDeps > 0,
      // code-spider-ok8
      details: beadsAvailable
        ? `issues:${issues}, tracked:${trackedBy}, deps:${issueDeps}`
        : `${beadsUnavailableDetails} (issues:${issues}, tracked:${trackedBy}, deps:${issueDeps})`,
    },
  ]
}

// code-spider-wa3
function checkMatchesScope(check: Check, scope: DoctorScope): boolean {
  if (scope === 'semantic') {
    // Per-language analyzer checks are named `${language}:${analyzerId}`.
    return check.name.includes(':')
  }
  if (scope === 'repo') {
    return ['git', 'rg', 'database'].includes(check.name)
  }
  return ['repo-size', 'database'].includes(check.name)
}

export class DoctorService {
  // code-spider-wa3
  async run(repoRoot: string, dbPath: string, scope?: DoctorScope): Promise<DoctorReport> {
  const registry = loadDefaultAnalyzerRegistry()
  const plugins = new BuiltinLanguagePluginRegistry(
    registry,
    // code-spider-ijq
    (bin: string) => commandExists(bin),
  )
    const gitCheck = checkGit(repoRoot)
    const rgCheck = checkRg()
    const { check: dbCheck, db, lastRunId, fileCount: _fileCount } = checkDatabase(dbPath)
    const detectedLanguages = detectLanguages(repoRoot, registry, plugins)
    const registryChecks = checkSelectedAnalyzers(repoRoot, detectedLanguages, plugins)
    const selectedPlugins = checkPlugins(repoRoot, detectedLanguages, plugins)
    const repoSizeCheck = checkRepoSize(repoRoot, db, lastRunId)
    const lastRunCoverage = summarizeLastRunCoverage(db, lastRunId)
    const contextEnrichers = summarizeContextEnrichers(
      repoRoot,
      db,
      lastRunId,
      gitCheck.status === 'pass',
    )

    const checks: Check[] = [
      gitCheck,
      rgCheck,
      dbCheck,
      ...registryChecks.checks,
      repoSizeCheck,
    ]

    const dbExists = existsSync(dbPath)
    const availableCapabilities = registryChecks.capabilities

    // code-spider-83v
    const structural = dbExists && lastRunId !== null

    // code-spider-h25
    const fidelity: FidelityReport = {
      structural,
      hotspot: gitCheck.status === 'pass',
      // code-spider-83v
      // Flow detection needs both rg (pattern scanning) and a structural
      // index (nodes/symbols queries) — rg alone cannot produce flows.
      flowHeuristics: rgCheck.status === 'pass' && structural,
      symbolNavigation: semanticFidelity(lastRunCoverage, ['symbols', 'defs'], availableCapabilities),
      semanticRefs: semanticFidelity(lastRunCoverage, ['refs'], availableCapabilities),
      diagnostics: semanticFidelity(lastRunCoverage, ['diagnostics'], availableCapabilities),
    }

    return {
      repoRoot,
      // code-spider-wa3
      scope: scope ?? null,
      dbExists,
      lastRunId,
      detectedLanguages: detectedLanguages.map(language => language.id),
      selectedAnalyzers: registryChecks.selectedAnalyzers,
      selectedPlugins,
      lastRunCoverage,
      // code-spider-wa3
      checks: scope === undefined ? checks : checks.filter(check => checkMatchesScope(check, scope)),
      fidelity,
      contextEnrichers,
      // code-spider-2ak
      recommendations: buildRecommendations(checks, fidelity),
    }
  }
}

// code-spider-2ak
function buildRecommendations(checks: Check[], fidelity: FidelityReport): string[] {
  const recommendations: string[] = []

  if (!fidelity.structural) {
    recommendations.push('No readable index — run: code-spider index')
  }

  const semanticStates = [fidelity.symbolNavigation, fidelity.semanticRefs, fidelity.diagnostics]
  if (semanticStates.includes('warn')) {
    recommendations.push('Semantic capabilities are available but unverified — run: code-spider index --semantic')
  } else if (semanticStates.includes('fail')) {
    recommendations.push('Semantic capabilities are degraded — defs/refs results may be limited to indexed symbols')
  }

  for (const check of checks) {
    if (check.status !== 'pass' && check.remedy !== undefined) {
      recommendations.push(`${check.name}: ${check.remedy}`)
    }
  }

  return recommendations
}
