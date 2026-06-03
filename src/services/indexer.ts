import { basename } from 'node:path'
import { openDb } from '../db/init'
import { BeadsAdapter } from '../adapters/beads'
import { FilesystemAdapter } from '../adapters/filesystem'
import { GitAdapter, type GitCommitRecord } from '../adapters/git'
import { LineCountAdapter } from '../adapters/line-count'
import { BeadsContextIndexer } from './beads-context'
// code-spider-ofm
import { loadDefaultAnalyzerRegistrySafe, registryExtensionLanguages } from '../analyzer-registry-loader'
import { MarkdownContextIndexer } from './markdown-context'

export interface IndexOptions {
  repoRoot: string
  dbPath: string
}

export interface IndexResult {
  runId: number
  fileCount: number
  zoneCount: number
  durationMs: number
  beads?: {
    issuesAdded: number
    dependencyEdgesAdded: number
    trackingEdgesAdded: number
  }
  git?: {
    evidenceAdded: number
    cochangeEdgesAdded: number
  }
  markdown?: {
    docsAdded: number
    sectionsAdded: number
    mentionEdgesAdded: number
  }
}

interface GitPairSummary {
  count: number
  sampleHash: string
  sampleSubject: string
  sampleTimestamp: number
}

function indexGitHistory(commits: GitCommitRecord[], trackedPaths: Set<string>): {
  churnMap: Map<string, number>
  recencyMap: Map<string, number>
  recentCommitsByPath: Map<string, GitCommitRecord[]>
  cochangePairs: Map<string, GitPairSummary>
} {
  const churnMap = new Map<string, number>()
  const recencyMap = new Map<string, number>()
  const recentCommitsByPath = new Map<string, GitCommitRecord[]>()
  const cochangePairs = new Map<string, GitPairSummary>()

  for (const commit of commits) {
    if (commit.subject.startsWith('Merge ')) continue

    const files = [...new Set(commit.files)].filter(file => trackedPaths.has(file))
    if (files.length === 0) continue

    for (const file of files) {
      churnMap.set(file, (churnMap.get(file) ?? 0) + 1)

      const existingRecency = recencyMap.get(file)
      if (existingRecency === undefined || commit.timestamp > existingRecency) {
        recencyMap.set(file, commit.timestamp)
      }

      const fileCommits = recentCommitsByPath.get(file) ?? []
      fileCommits.push(commit)
      fileCommits.sort((a, b) => b.timestamp - a.timestamp)
      recentCommitsByPath.set(file, fileCommits.slice(0, 3))
    }

    if (files.length < 2 || files.length > 8) continue
    const sortedFiles = [...files].sort()
    for (let i = 0; i < sortedFiles.length; i++) {
      const from = sortedFiles[i]
      if (from === undefined) continue
      for (let j = i + 1; j < sortedFiles.length; j++) {
        const to = sortedFiles[j]
        if (to === undefined) continue
        const key = `${from}\u0000${to}`
        const existing = cochangePairs.get(key)
        if (existing) {
          existing.count += 1
          if (commit.timestamp > existing.sampleTimestamp) {
            existing.sampleHash = commit.hash
            existing.sampleSubject = commit.subject
            existing.sampleTimestamp = commit.timestamp
          }
        } else {
          cochangePairs.set(key, {
            count: 1,
            sampleHash: commit.hash,
            sampleSubject: commit.subject,
            sampleTimestamp: commit.timestamp,
          })
        }
      }
    }
  }

  return { churnMap, recencyMap, recentCommitsByPath, cochangePairs }
}

export class Indexer {
  async run(opts: IndexOptions): Promise<IndexResult> {
    const startTime = Date.now()
    const { repoRoot, dbPath } = opts
    const db = openDb(dbPath)

    // 1. Insert run record
    const startedAt = new Date().toISOString()
    const toolVersion = '0.1.0'
    const runStmt = db.prepare(
      'INSERT INTO runs (started_at, repo_root, repo_commit, tool_version) VALUES (?,?,?,?)'
    )
    const runResult = runStmt.run(startedAt, repoRoot, null, toolVersion)
    const runId = Number(runResult.lastInsertRowid)

    // 2. Run filesystem walk and git head commit in parallel
    const fsAdapter = new FilesystemAdapter()
    const gitAdapter = new GitAdapter(repoRoot)
    const beadsAdapter = new BeadsAdapter(repoRoot)

    // code-spider-ofm
    // Languages declared only in config/analyzers.yaml (e.g. a new Lisp) get
    // recognized at walk time, so their units carry the right language and
    // semantic enrichment picks them up — no bespoke plugin code required.
    const registryLanguages = registryExtensionLanguages(loadDefaultAnalyzerRegistrySafe().registry)

    const [files, headCommit, gitHistory, beadsIssues] = await Promise.all([
      fsAdapter.walk(repoRoot, registryLanguages),
      gitAdapter.getHeadCommit(),
      gitAdapter.getRecentHistory(),
      beadsAdapter.listIssues(),
    ])

    // 3. Update run with repo_commit
    db.prepare('UPDATE runs SET repo_commit=? WHERE id=?').run(headCommit, runId)

    // 4. Insert repo-level node
    const insertNode = db.prepare(
      `INSERT OR IGNORE INTO nodes (run_id, kind, key, label, path, language)
       VALUES (?,?,?,?,?,?)`
    )
    insertNode.run(runId, 'repo', 'repo:.', basename(repoRoot), null, null)

    // 5. Detect zones and insert zone nodes
    const zones = fsAdapter.detectZones(files, repoRoot)
    for (const zone of zones) {
      // code-spider-eed
      // Persist the dominant language so `zones --kind` can filter on it.
      insertNode.run(runId, 'zone', `zone:${zone.name}`, zone.name, zone.name, zone.languages[0] ?? null)
    }

    // 6. Derive curated git context from recent history
    const trackedPaths = new Set(files.map(file => file.relPath))
    const {
      churnMap,
      recencyMap,
      recentCommitsByPath,
      cochangePairs,
    } = indexGitHistory(gitHistory, trackedPaths)

    // 7. Insert unit nodes and collect LOC data
    const lineCounter = new LineCountAdapter()
    const insertStat = db.prepare(
      'INSERT INTO stats (run_id, node_id, metric, value) VALUES (?,?,?,?)'
    )
    const getNodeId = db.prepare(
      'SELECT id FROM nodes WHERE run_id=? AND kind=? AND key=?'
    )
    const fileNodeIds = new Map<string, number>()

    // Count lines for all files in parallel (batched)
    const locResults = await Promise.all(files.map(f => lineCounter.countLines(f.path)))

    const nowSec = Math.floor(Date.now() / 1000)
    const secondsPerDay = 86400

    // Track max values for normalization
    let maxLoc = 1
    let maxChurn = 1
    const fileStats: Array<{ relPath: string; loc: number; churn: number; recencyDays: number }> = []

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file === undefined) continue
      const loc = locResults[i] ?? 0
      const churn = churnMap.get(file.relPath) ?? 0
      const lastTouched = recencyMap.get(file.relPath)
      const recencyDays = lastTouched !== undefined
        ? Math.floor((nowSec - lastTouched) / secondsPerDay)
        : 999

      fileStats.push({ relPath: file.relPath, loc, churn, recencyDays })
      if (loc > maxLoc) maxLoc = loc
      if (churn > maxChurn) maxChurn = churn
    }

    // Insert unit nodes
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file === undefined) continue
      const stats = fileStats[i]
      if (stats === undefined) continue

      insertNode.run(
        runId,
        'unit',
        `unit:${file.relPath}`,
        basename(file.relPath),
        file.relPath,
        file.language
      )

      const nodeRow = getNodeId.get(runId, 'unit', `unit:${file.relPath}`) as { id: number } | undefined
      if (nodeRow === undefined) continue
      const nodeId = nodeRow.id
      fileNodeIds.set(file.relPath, nodeId)

      insertStat.run(runId, nodeId, 'loc', stats.loc)
      insertStat.run(runId, nodeId, 'churn', stats.churn)
      insertStat.run(runId, nodeId, 'recency', stats.recencyDays)
    }

    // 8. Insert zone stats (aggregate LOC and max churn from children)
    for (const zone of zones) {
      const zoneRow = getNodeId.get(runId, 'zone', `zone:${zone.name}`) as { id: number } | undefined
      if (zoneRow === undefined) continue
      const zoneNodeId = zoneRow.id

      let zoneLoc = 0
      let zoneMaxChurn = 0
      for (let i = 0; i < files.length; i++) {
        const file = files[i]
        if (file === undefined) continue
        const stats = fileStats[i]
        if (stats === undefined) continue
        // Check if file belongs to this zone
        if (file.relPath.startsWith(zone.name + '/')) {
          zoneLoc += stats.loc
          if (stats.churn > zoneMaxChurn) zoneMaxChurn = stats.churn
        }
      }

      insertStat.run(runId, zoneNodeId, 'loc', zoneLoc)
      insertStat.run(runId, zoneNodeId, 'churn', zoneMaxChurn)
    }

    // 9. Insert evidence for detected manifests
    const manifests = await fsAdapter.detectManifests(repoRoot)
    const insertEvidence = db.prepare(
      `INSERT INTO evidence (run_id, node_id, edge_id, kind, source, locator, snippet, score)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    const insertEdge = db.prepare(
      `INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight, metadata_json)
       VALUES (?,?,?,?,?,?)`
    )
    // Get repo node id
    const repoRow = getNodeId.get(runId, 'repo', 'repo:.') as { id: number } | undefined
    const repoNodeId = repoRow?.id ?? null

    for (const manifest of manifests) {
      insertEvidence.run(runId, repoNodeId, null, 'manifest', manifest.path, null, manifest.kind, 0)
    }

    // 10. Insert curated git evidence and co-change edges
    let gitEvidenceAdded = 0
    for (const [relPath, commits] of recentCommitsByPath) {
      const nodeId = fileNodeIds.get(relPath)
      if (nodeId === undefined) continue
      for (const [index, commit] of commits.entries()) {
        insertEvidence.run(
          runId,
          nodeId,
          null,
          'git',
          commit.hash.slice(0, 7),
          new Date(commit.timestamp * 1000).toISOString().slice(0, 10),
          commit.subject,
          Math.max(0.6, 1 - index * 0.1),
        )
        gitEvidenceAdded++
      }
    }

    let cochangeEdgesAdded = 0
    for (const [pairKey, summary] of [...cochangePairs.entries()]
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, 500)) {
      const [fromPath, toPath] = pairKey.split('\u0000')
      if (!fromPath || !toPath) continue
      const fromNodeId = fileNodeIds.get(fromPath)
      const toNodeId = fileNodeIds.get(toPath)
      if (fromNodeId === undefined || toNodeId === undefined) continue
      insertEdge.run(
        runId,
        fromNodeId,
        toNodeId,
        'changed-with',
        summary.count,
        JSON.stringify({
          sampleHash: summary.sampleHash,
          sampleSubject: summary.sampleSubject,
          sampleTimestamp: summary.sampleTimestamp,
        }),
      )
      cochangeEdgesAdded++
    }

    // 11. Index markdown context
    const markdown = new MarkdownContextIndexer().run(db, runId, repoRoot)

    // 12. Index beads issue context
    const beads = new BeadsContextIndexer().run(db, runId, beadsIssues)

    // 13. Compute and update scores for unit nodes
    const updateScore = db.prepare('UPDATE nodes SET score=? WHERE id=?')
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      if (file === undefined) continue
      const stats = fileStats[i]
      if (stats === undefined) continue

      const nodeRow = getNodeId.get(runId, 'unit', `unit:${file.relPath}`) as { id: number } | undefined
      if (nodeRow === undefined) continue

      const churnNorm = stats.churn / maxChurn
      const locNorm = stats.loc / maxLoc
      const score = churnNorm * 0.6 + locNorm * 0.4
      updateScore.run(score, nodeRow.id)
    }

    // 14. Mark run as complete
    const completedAt = new Date().toISOString()
    db.prepare('UPDATE runs SET completed_at=? WHERE id=?').run(completedAt, runId)

    const durationMs = Date.now() - startTime

    return {
      runId,
      fileCount: files.length,
      zoneCount: zones.length,
      durationMs,
      beads,
      git: {
        evidenceAdded: gitEvidenceAdded,
        cochangeEdgesAdded,
      },
      markdown,
    }
  }
}
