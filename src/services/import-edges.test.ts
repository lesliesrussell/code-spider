// code-spider-89w
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { scanUnitImports } from './import-edges'
import { Indexer } from './indexer'
import { openDb } from '../db/init'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'import-edges-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

describe('scanUnitImports', () => {
  test('resolves static relative imports between known units', async () => {
    const root = makeRepo({
      'src/a.ts': "import { b } from './b'\nexport const a = b",
      'src/b.ts': 'export const b = 1',
    })
    const records = await scanUnitImports(root, ['src/a.ts', 'src/b.ts'])
    expect(records).toEqual([{ fromPath: 'src/a.ts', toPath: 'src/b.ts', confidence: 1 }])
  })

  test('dynamic imports get confidence below 1', async () => {
    const root = makeRepo({
      'src/a.ts': "export async function load() { return import('./b') }",
      'src/b.ts': 'export const b = 1',
    })
    const records = await scanUnitImports(root, ['src/a.ts', 'src/b.ts'])
    expect(records).toHaveLength(1)
    expect(records[0]!.toPath).toBe('src/b.ts')
    expect(records[0]!.confidence).toBeLessThan(1)
  })

  test('resolves directory imports through index files and parent-relative paths', async () => {
    const root = makeRepo({
      'src/app.ts': "import { util } from './lib'\nimport { deep } from '../shared/deep'\nexport const x = [util, deep]",
      'src/lib/index.ts': 'export const util = 1',
      'shared/deep.ts': 'export const deep = 2',
    })
    const records = await scanUnitImports(root, ['src/app.ts', 'src/lib/index.ts', 'shared/deep.ts'])
    const targets = records.map(r => r.toPath).sort()
    expect(targets).toEqual(['shared/deep.ts', 'src/lib/index.ts'])
  })

  test('skips bare package specifiers and unresolvable paths without error', async () => {
    const root = makeRepo({
      'src/a.ts': "import { x } from 'left-pad'\nimport { y } from './missing'\nexport const a = [x, y]",
    })
    const records = await scanUnitImports(root, ['src/a.ts'])
    expect(records).toEqual([])
  })

  test('a syntactically broken file fails soft and yields no records', async () => {
    const root = makeRepo({
      'src/broken.ts': 'import {{{{ nope',
      'src/ok.ts': "import { b } from './b'\nexport const ok = b",
      'src/b.ts': 'export const b = 1',
    })
    const records = await scanUnitImports(root, ['src/broken.ts', 'src/ok.ts', 'src/b.ts'])
    expect(records).toEqual([{ fromPath: 'src/ok.ts', toPath: 'src/b.ts', confidence: 1 }])
  })

  test('is deterministic: repeated scans return identical ordered records', async () => {
    const root = makeRepo({
      'src/a.ts': "import './b'\nimport './c'",
      'src/b.ts': "import './c'",
      'src/c.ts': 'export {}',
    })
    const units = ['src/a.ts', 'src/b.ts', 'src/c.ts']
    const first = await scanUnitImports(root, units)
    const second = await scanUnitImports(root, units)
    expect(second).toEqual(first)
    expect(first.map(r => `${r.fromPath}>${r.toPath}`)).toEqual([
      'src/a.ts>src/b.ts',
      'src/a.ts>src/c.ts',
      'src/b.ts>src/c.ts',
    ])
  })
})

describe('Indexer import edges', () => {
  test('indexing writes imports edges with confidence between unit nodes', async () => {
    const root = makeRepo({
      'src/a.ts': "import { b } from './b'\nexport const a = b",
      'src/b.ts': "export async function lazy() { return import('./c') }\nexport const b = 1",
      'src/c.ts': 'export const c = 1',
    })
    const dbPath = join(root, '.code-spider', 'index.db')
    await new Indexer().run({ repoRoot: root, dbPath })

    const db = openDb(dbPath)
    const rows = db
      .query(
        `SELECT n1.path AS fromPath, n2.path AS toPath, e.confidence
         FROM edges e
         JOIN nodes n1 ON e.from_node_id = n1.id
         JOIN nodes n2 ON e.to_node_id = n2.id
         WHERE e.kind = 'imports'
         ORDER BY fromPath, toPath`
      )
      .all() as Array<{ fromPath: string; toPath: string; confidence: number }>
    db.close()

    expect(rows).toEqual([
      { fromPath: 'src/a.ts', toPath: 'src/b.ts', confidence: 1 },
      { fromPath: 'src/b.ts', toPath: 'src/c.ts', confidence: 0.5 },
    ])
  })
})
