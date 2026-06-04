// code-spider-sgm
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { ManifestAnalyzer } from './manifest'
import { FindingsStore } from './findings'
import { openDb } from '../db/init'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'tested-by-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

async function indexRepo(files: Record<string, string>) {
  const root = makeRepo(files)
  const dbPath = join(root, '.code-spider', 'index.db')
  const result = await new Indexer().run({ repoRoot: root, dbPath })
  return { root, dbPath, runId: result.runId, db: openDb(dbPath) }
}

function testedByEdges(db: ReturnType<typeof openDb>, runId: number) {
  return db
    .query(
      `SELECT n1.path AS subject, n2.path AS testFile, e.confidence
       FROM edges e
       JOIN nodes n1 ON e.from_node_id = n1.id
       JOIN nodes n2 ON e.to_node_id = n2.id
       WHERE e.run_id = ? AND e.kind = 'tested-by'
       ORDER BY subject, testFile`
    )
    .all(runId) as Array<{ subject: string; testFile: string; confidence: number }>
}

describe('tested-by edge population', () => {
  test('import-derived edges at confidence 1, convention-only at 0.8', async () => {
    const { db, runId } = await indexRepo({
      // a.test.ts imports its subject — import-derived
      'src/a.ts': 'export const a = 1',
      'src/a.test.ts': "import { a } from './a'\nexport const t = a",
      // b.test.ts sits next to b.ts but never imports it — convention-only
      'src/b.ts': 'export const b = 1',
      'src/b.test.ts': 'export {}',
      // helper imported by a test that is not its sibling — import-derived too
      'src/util.ts': 'export const u = 1',
    })
    const edges = testedByEdges(db, runId)
    expect(edges).toEqual([
      { subject: 'src/a.ts', testFile: 'src/a.test.ts', confidence: 1 },
      { subject: 'src/b.ts', testFile: 'src/b.test.ts', confidence: 0.8 },
    ])
  })

  test('a test importing several units yields one edge per imported unit', async () => {
    const { db, runId } = await indexRepo({
      'src/x.ts': 'export const x = 1',
      'src/y.ts': 'export const y = 1',
      'test/integration.test.ts': "import { x } from '../src/x'\nimport { y } from '../src/y'\nexport const t = [x, y]",
    })
    const edges = testedByEdges(db, runId)
    expect(edges.map(e => `${e.subject}>${e.testFile}`)).toEqual([
      'src/x.ts>test/integration.test.ts',
      'src/y.ts>test/integration.test.ts',
    ])
  })

  test('test-to-test imports produce no tested-by edges; re-index is deterministic', async () => {
    const files = {
      'src/a.ts': 'export const a = 1',
      'src/a.test.ts': "import { a } from './a'\nimport './b.test'\nexport const t = a",
      'src/b.test.ts': 'export {}',
    }
    const first = await indexRepo(files)
    const firstEdges = testedByEdges(first.db, first.runId)
    expect(firstEdges.map(e => e.subject)).toEqual(['src/a.ts'])

    const again = await new Indexer().run({ repoRoot: first.root, dbPath: first.dbPath })
    const secondEdges = testedByEdges(openDb(first.dbPath), again.runId)
    expect(secondEdges).toEqual(firstEdges)
  })
})

describe('orphan-test consumes tested-by edges', () => {
  test('a co-located test with a missing sibling but real imports is rescued', async () => {
    const { db, runId } = await indexRepo({
      'package.json': '{"name":"x"}',
      // subject was renamed away: no renamed-thing.ts, but the test still
      // imports a real unit — it tests something that exists.
      'src/renamed-thing.test.ts': "import { real } from './real'\nexport const t = real",
      'src/real.ts': 'export const real = 1',
      // genuinely orphaned: sibling gone, imports nothing in the repo
      'src/gone.test.ts': 'export {}',
    })
    await new ManifestAnalyzer().analyze(db, runId)
    const orphans = new FindingsStore(db, runId).list({ ruleId: 'orphan-test' })
    expect(orphans.map(f => f.locations[0]!.path)).toEqual(['src/gone.test.ts'])
  })
})
