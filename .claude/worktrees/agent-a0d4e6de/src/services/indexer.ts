import { basename } from 'node:path'
import { openDb } from '../db/init'
import { FilesystemAdapter } from '../adapters/filesystem'
import { GitAdapter } from '../adapters/git'
import { LineCountAdapter } from '../adapters/line-count'

export interface IndexOptions {
  repoRoot: string
  dbPath: string
  incremental?: boolean
}

export interface IndexResult {
  runId: number
  fileCount: number
  zoneCount: number
  durationMs: number
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

    const [files, headCommit] = await Promise.all([
      fsAdapter.walk(repoRoot),
      gitAdapter.getHeadCommit(),
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
      insertNode.run(runId, 'zone', `zone:${zone.name}`, zone.name, zone.name, null)
    }

    // 6. Get churn and recency in parallel
    const [churnMap, recencyMap] = await Promise.all([
      gitAdapter.getChurn(),
      gitAdapter.getRecency(),
    ])

    // 7. Insert unit nodes and collect LOC data
    const lineCounter = new LineCountAdapter()
    const insertStat = db.prepare(
      'INSERT INTO stats (run_id, node_id, metric, value) VALUES (?,?,?,?)'
    )
    const getNodeId = db.prepare(
      'SELECT id FROM nodes WHERE run_id=? AND kind=? AND key=?'
    )

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
    // Get repo node id
    const repoRow = getNodeId.get(runId, 'repo', 'repo:.') as { id: number } | undefined
    const repoNodeId = repoRow?.id ?? null

    for (const manifest of manifests) {
      insertEvidence.run(runId, repoNodeId, null, 'manifest', manifest.path, null, manifest.kind, 0)
    }

    // 10. Compute and update scores for unit nodes
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

    // 11. Mark run as complete
    const completedAt = new Date().toISOString()
    db.prepare('UPDATE runs SET completed_at=? WHERE id=?').run(completedAt, runId)

    const durationMs = Date.now() - startTime

    return {
      runId,
      fileCount: files.length,
      zoneCount: zones.length,
      durationMs,
    }
  }
}
