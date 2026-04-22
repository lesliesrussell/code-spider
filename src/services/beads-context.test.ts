import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { type BeadsIssue } from '../adapters/beads'
import { BeadsContextIndexer } from './beads-context'
import { Navigator } from './navigator'
import { RelatedService } from './related'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDbPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return join(dir, 'index.db')
}

describe('BeadsContextIndexer', () => {
  test('creates issue nodes, dependency edges, and tracked-by links from explicit refs', async () => {
    const dbPath = makeTempDbPath('code-spider-beads-context')
    const db = openDb(dbPath)

    db.query(
      'INSERT INTO runs (id, started_at, completed_at, repo_root, repo_commit, tool_version) VALUES (1,?,?,?,?,?)'
    ).run('2026-04-22T00:00:00Z', '2026-04-22T00:01:00Z', '/tmp/repo', 'abc1234', 'test')

    db.query(
      `INSERT INTO nodes (id, run_id, kind, key, label, path, language, score, confidence)
       VALUES
         (1, 1, 'repo', 'repo:.', 'repo', null, null, 0, 1),
         (2, 1, 'zone', 'zone:src', 'src', 'src', null, 0, 1),
         (3, 1, 'unit', 'unit:src/index.ts', 'index.ts', 'src/index.ts', 'TypeScript', 0, 1),
         (4, 1, 'unit', 'unit:src/services/indexer.ts', 'indexer.ts', 'src/services/indexer.ts', 'TypeScript', 0, 1)`
    ).run()

    db.query(
      `INSERT INTO stats (run_id, node_id, metric, value)
       VALUES
         (1, 3, 'loc', 10), (1, 3, 'churn', 1), (1, 3, 'recency', 1),
         (1, 4, 'loc', 12), (1, 4, 'churn', 1), (1, 4, 'recency', 1)`
    ).run()

    const issues: BeadsIssue[] = [
      {
        id: 'code-spider-7lv',
        title: 'Implement beads issue/context enrichment',
        description: 'Track work touching src/index.ts and unit:src/services/indexer.ts.',
        status: 'in_progress',
        dependencies: [
          {
            issue_id: 'code-spider-7lv',
            depends_on_id: 'code-spider-pg4',
            type: 'blocks',
          },
        ],
      },
      {
        id: 'code-spider-pg4',
        title: 'Build curated context layer',
        description: 'Epic for src/index.ts narrative and context.',
        status: 'open',
      },
    ]

    const result = new BeadsContextIndexer().run(db, 1, issues)

    expect(result).toEqual({
      issuesAdded: 2,
      dependencyEdgesAdded: 1,
      trackingEdgesAdded: 3,
    })

    const issueCount = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM nodes WHERE run_id=? AND kind='issue'`
    ).get(1)?.count
    const trackedCount = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM edges WHERE run_id=? AND kind='tracked-by'`
    ).get(1)?.count

    expect(issueCount).toBe(2)
    expect(trackedCount).toBe(3)

    const nav = new Navigator(db, 1)
    const node = nav.getNode('unit:src/index.ts')
    expect(node).not.toBeNull()

    const beadsContext = nav.getBeadsContext(node!.id, 5)
    expect(beadsContext.map(item => item.issueId)).toEqual(['code-spider-7lv', 'code-spider-pg4'])
    expect(beadsContext[0]).toMatchObject({
      status: 'in_progress',
      title: 'Implement beads issue/context enrichment',
    })

    const related = await new RelatedService(db, 1, '/tmp/repo').getRelated('unit:src/index.ts', 5)
    expect(related[0]?.key).toBe('unit:src/services/indexer.ts')
    expect(related[0]?.reasons.some(reason => reason.includes('tracked together by code-spider-7lv'))).toBe(true)
  })
})
