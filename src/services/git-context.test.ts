import { afterEach, describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { Indexer } from './indexer'
import { Navigator } from './navigator'
import { RelatedService } from './related'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempRepo(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function runGit(repoRoot: string, args: string, date?: string): void {
  execSync(`git ${args}`, {
    cwd: repoRoot,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
    },
  })
}

describe('git contextual enrichment', () => {
  test('indexes recent commit rationale and co-change links', async () => {
    const repoRoot = makeTempRepo('code-spider-git-context')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(repoRoot, 'src', 'b.ts'), 'export const b = 1\n')

    runGit(repoRoot, 'init')
    runGit(repoRoot, 'config user.name "Code Spider Test"')
    runGit(repoRoot, 'config user.email "code-spider@example.com"')

    runGit(repoRoot, 'add .')
    runGit(repoRoot, 'commit -m "initial import"', '2026-04-18T12:00:00Z')

    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 2\nexport const shared = true\n')
    writeFileSync(join(repoRoot, 'src', 'b.ts'), 'export const b = 2\nexport const shared = true\n')
    runGit(repoRoot, 'add .')
    runGit(repoRoot, 'commit -m "refactor shared runtime"', '2026-04-19T12:00:00Z')

    writeFileSync(join(repoRoot, 'src', 'a.ts'), 'export const a = 3\nexport const shared = true\n')
    runGit(repoRoot, 'add .')
    runGit(repoRoot, 'commit -m "polish a module"', '2026-04-20T12:00:00Z')

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const result = await new Indexer().run({ repoRoot, dbPath })

    expect(result.git).toBeDefined()
    expect(result.git?.evidenceAdded).toBeGreaterThan(0)
    expect(result.git?.cochangeEdgesAdded).toBeGreaterThan(0)

    const db = openDb(dbPath)
    const nav = new Navigator(db, result.runId)
    const node = nav.getNode('unit:src/a.ts')
    expect(node).not.toBeNull()

    const gitContext = nav.getGitContext(node!.id, 5)
    expect(gitContext.some(item => item.snippet === 'polish a module')).toBe(true)
    expect(gitContext.some(item => item.snippet === 'refactor shared runtime')).toBe(true)

    const cochangeEdges = db.query<{ weight: number }, [number]>(
      `SELECT weight
       FROM edges
       WHERE run_id=?
         AND kind='changed-with'`
    ).all(result.runId)
    expect(cochangeEdges.some(edge => edge.weight >= 1)).toBe(true)

    const related = await new RelatedService(db, result.runId, repoRoot).getRelated('unit:src/a.ts', 5)
    expect(related[0]?.key).toBe('unit:src/b.ts')
    expect(related[0]?.reasons.some(reason => reason.includes('co-changed in'))).toBe(true)
  })
})
