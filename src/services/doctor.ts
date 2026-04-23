import { execSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import type { AnalyzerCapability, AnalyzerRegistryDocument, RegistryLanguage } from '../analyzer-registry'
import { BuiltinLanguagePluginRegistry } from '../language-plugin-registry'
import { openDb } from '../db/init'

export type CheckStatus = 'pass' | 'warn' | 'fail'

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
  symbolNavigation: boolean
  semanticRefs: boolean
  diagnostics: boolean
}

export interface DoctorReport {
  repoRoot: string
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
  } catch {
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

function walkRepoFiles(root: string, maxEntries = 2000): string[] {
  const results: string[] = []
  const queue = ['']
  const ignored = new Set(['.git', 'node_modules', '.code-spider', '.beads', '.claude', '.nardo', '.omc'])

  while (queue.length > 0 && results.length < maxEntries) {
    const relDir = queue.shift()
    if (relDir === undefined) break
    const fullDir = relDir === '' ? root : join(root, relDir)

    let entries: import('node:fs').Dirent<string>[]
    try {
      entries = readdirSync(fullDir, { withFileTypes: true, encoding: 'utf8' })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue
        const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        queue.push(childRel)
      } else if (entry.isFile()) {
        const childRel = relDir === '' ? entry.name : `${relDir}/${entry.name}`
        results.push(childRel)
        if (results.length >= maxEntries) break
      }
    }
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
  } catch {
    return {
      check: { name: 'database', status: 'warn', message: 'database exists but could not be read' },
      db,
      lastRunId: null,
      lastRunDate: null,
      fileCount: null,
    }
  }
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

function hasSemanticRefsFidelity(
  coverage: DoctorReport['lastRunCoverage'],
  availableCapabilities: Set<AnalyzerCapability>,
): boolean {
  const refsCoverage = coverage.find(item => item.capability === 'refs')
  if (refsCoverage !== undefined) return refsCoverage.succeeded
  return availableCapabilities.has('refs')
}

function summarizeContextEnrichers(
  repoRoot: string,
  db: Database | null,
  lastRunId: number | null,
  gitAvailable: boolean,
): DoctorReport['contextEnrichers'] {
  const markdownAvailable = hasMarkdownFiles(repoRoot)
  const beadsAvailable = existsSync(join(repoRoot, '.beads')) && tryExec('bd --version') !== null

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
        details: beadsAvailable ? 'no completed run yet' : 'no beads workspace or bd command unavailable',
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
      details: `issues:${issues}, tracked:${trackedBy}, deps:${issueDeps}`,
    },
  ]
}

export class DoctorService {
  async run(repoRoot: string, dbPath: string, _scope?: string): Promise<DoctorReport> {
  const registry = loadDefaultAnalyzerRegistry()
  const plugins = new BuiltinLanguagePluginRegistry(
    registry,
    (bin: string) => tryExec(`which ${bin}`) !== null,
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
    const lastRunCapabilities = new Set(
      lastRunCoverage.filter(item => item.succeeded).map(item => item.capability)
    )
    const effectiveCapabilities = lastRunCoverage.length > 0
      ? lastRunCapabilities
      : registryChecks.capabilities

    const fidelity: FidelityReport = {
      structural: dbExists && lastRunId !== null,
      hotspot: gitCheck.status === 'pass',
      flowHeuristics: rgCheck.status === 'pass',
      symbolNavigation: effectiveCapabilities.has('symbols') || effectiveCapabilities.has('defs'),
      semanticRefs: hasSemanticRefsFidelity(lastRunCoverage, registryChecks.capabilities),
      diagnostics: effectiveCapabilities.has('diagnostics'),
    }

    return {
      repoRoot,
      dbExists,
      lastRunId,
      detectedLanguages: detectedLanguages.map(language => language.id),
      selectedAnalyzers: registryChecks.selectedAnalyzers,
      selectedPlugins,
      lastRunCoverage,
      checks,
      fidelity,
      contextEnrichers,
    }
  }
}
