// code-spider-ebz
// Deletes stale runs to bound database growth. Protected runs are never
// deleted: the newest completed run, the newest with symbols, the newest
// with embeddings (the capability-fallback targets resolveRunFor depends
// on), any run referenced by an investigation, and the --keep newest.
// See docs/run-lifecycle-design.md.
import type { Database } from 'bun:sqlite'
import { Navigator } from './navigator'

export interface PruneOptions {
  db: Database
  repoRoot: string
  keep: number
  dryRun?: boolean
}

export interface PruneResult {
  deletedRunIds: number[]
  protectedRunIds: number[]
  pagesBefore: number
  pagesAfter: number
}

// Deletion order respects foreign keys: children before parents.
const RUN_SCOPED_TABLES = [
  'symbol_edges',
  'diagnostics',
  'symbols',
  'embeddings',
  'evidence',
  'findings',
  'stats',
  'edges',
  'analyzer_runs',
  'token_events',
  'analyzers',
  'nodes',
] as const

export function protectedRunIds(db: Database, repoRoot: string, keep: number): Set<number> {
  const ids = new Set<number>()
  for (const id of Navigator.listRunIds(db, repoRoot, Math.max(keep, 1))) ids.add(id)
  for (const capability of ['symbols', 'embeddings'] as const) {
    const resolved = Navigator.resolveRunFor(db, repoRoot, capability)
    if (resolved.runId !== null) ids.add(resolved.runId)
  }
  const investigationRuns = db.query<{ run_id: number }, []>(
    'SELECT DISTINCT run_id FROM investigations WHERE run_id IS NOT NULL'
  ).all()
  for (const row of investigationRuns) ids.add(row.run_id)
  return ids
}

export function pruneRuns(options: PruneOptions): PruneResult {
  const { db, repoRoot, keep, dryRun = false } = options

  const pageCount = (): number =>
    (db.query<{ page_count: number }, []>('PRAGMA page_count').get())?.page_count ?? 0

  const pagesBefore = pageCount()
  const keepIds = protectedRunIds(db, repoRoot, keep)
  const allRuns = db.query<{ id: number }, string>(
    'SELECT id FROM runs WHERE repo_root=? ORDER BY id ASC'
  ).all(repoRoot).map(row => row.id)
  const deletedRunIds = allRuns.filter(id => !keepIds.has(id))

  if (dryRun || deletedRunIds.length === 0) {
    return { deletedRunIds, protectedRunIds: [...keepIds].sort((a, b) => a - b), pagesBefore, pagesAfter: pagesBefore }
  }

  const placeholders = deletedRunIds.map(() => '?').join(',')
  db.transaction(() => {
    for (const table of RUN_SCOPED_TABLES) {
      db.query(`DELETE FROM ${table} WHERE run_id IN (${placeholders})`).run(...deletedRunIds)
    }
    db.query(`DELETE FROM runs WHERE id IN (${placeholders})`).run(...deletedRunIds)
  })()
  db.run('VACUUM')

  return { deletedRunIds, protectedRunIds: [...keepIds].sort((a, b) => a - b), pagesBefore, pagesAfter: pageCount() }
}
