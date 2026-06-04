// code-spider-ty9
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { ManifestAnalyzer } from './manifest'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function seedRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  const db = openDb(join(root, '.code-spider', 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', ?)").run(root)
  const insertNode = db.prepare(
    `INSERT INTO nodes (run_id, kind, key, label, path, language) VALUES (1, 'unit', ?, ?, ?, 'TypeScript')`
  )
  for (const rel of Object.keys(files)) {
    if (rel === 'package.json') continue
    insertNode.run(`unit:${rel}`, rel.split('/').pop() ?? rel, rel)
  }
  return { root, db }
}

function findings(db: ReturnType<typeof openDb>, ruleId: string) {
  return new FindingsStore(db, 1).list({ ruleId })
}

const PKG = (deps: Record<string, string>, dev: Record<string, string> = {}, scripts: Record<string, string> = {}) =>
  JSON.stringify({ name: 'fixture', dependencies: deps, devDependencies: dev, scripts })

describe('ManifestAnalyzer unused-dependency', () => {
  test('a declared dependency imported nowhere is flagged', async () => {
    const { db } = seedRepo({
      'package.json': PKG({ 'left-pad': '1.0.0', 'used-pkg': '2.0.0' }),
      'src/a.ts': "import { x } from 'used-pkg'\nexport const a = x",
    })
    await new ManifestAnalyzer().analyze(db, 1)
    const unused = findings(db, 'unused-dependency')
    expect(unused).toHaveLength(1)
    expect(unused[0]!.summary).toContain('left-pad')
    expect(unused[0]!.confidence).toBe('medium')
  })

  test('type-only imports and subpath imports count as usage', async () => {
    const { db } = seedRepo({
      'package.json': PKG({ 'typed-pkg': '1.0.0', 'subpath-pkg': '1.0.0', '@scope/pkg': '1.0.0' }),
      'src/a.ts': [
        "import type { T } from 'typed-pkg'",
        "import { y } from 'subpath-pkg/deep/module'",
        "import { z } from '@scope/pkg/sub'",
        'export const a: T = { y, z } as T',
      ].join('\n'),
    })
    await new ManifestAnalyzer().analyze(db, 1)
    expect(findings(db, 'unused-dependency')).toEqual([])
  })

  test('@types packages and script-referenced packages are not flagged', async () => {
    const { db } = seedRepo({
      'package.json': PKG({}, { '@types/node': '1.0.0', tsup: '8.0.0' }, { build: 'tsup src/index.ts' }),
      'src/a.ts': 'export {}',
    })
    await new ManifestAnalyzer().analyze(db, 1)
    expect(findings(db, 'unused-dependency')).toEqual([])
  })

  test('unused devDependencies are flagged at low confidence', async () => {
    const { db } = seedRepo({
      'package.json': PKG({}, { 'dead-tool': '1.0.0' }),
      'src/a.ts': 'export {}',
    })
    await new ManifestAnalyzer().analyze(db, 1)
    const unused = findings(db, 'unused-dependency')
    expect(unused).toHaveLength(1)
    expect(unused[0]!.confidence).toBe('low')
  })

  test('no package.json degrades to zero findings', async () => {
    const { db } = seedRepo({ 'src/a.ts': 'export {}' })
    await new ManifestAnalyzer().analyze(db, 1)
    expect(findings(db, 'unused-dependency')).toEqual([])
  })
})

describe('ManifestAnalyzer orphan-test', () => {
  test('a test file whose subject is missing is flagged', async () => {
    const { db } = seedRepo({
      'package.json': PKG({}),
      'src/deleted-thing.test.ts': "import { test } from 'bun:test'\ntest('x', () => {})",
      'src/present.test.ts': "import { test } from 'bun:test'\ntest('y', () => {})",
      'src/present.ts': 'export const p = 1',
    })
    await new ManifestAnalyzer().analyze(db, 1)
    const orphans = findings(db, 'orphan-test')
    expect(orphans).toHaveLength(1)
    expect(orphans[0]!.locations[0]!.path).toBe('src/deleted-thing.test.ts')
    expect(orphans[0]!.confidence).toBe('medium')
  })

  test('integration-style tests without a sibling convention are not flagged', async () => {
    const { db } = seedRepo({
      'package.json': PKG({}),
      'test/fixture-integration.test.ts': "import { test } from 'bun:test'\ntest('x', () => {})",
    })
    await new ManifestAnalyzer().analyze(db, 1)
    expect(findings(db, 'orphan-test')).toEqual([])
  })

  test('re-running is idempotent with identical fingerprints', async () => {
    const { db } = seedRepo({
      'package.json': PKG({ 'left-pad': '1.0.0' }),
      'src/a.test.ts': 'export {}',
    })
    const analyzer = new ManifestAnalyzer()
    await analyzer.analyze(db, 1)
    const first = new FindingsStore(db, 1).list()
    await analyzer.analyze(db, 1)
    const second = new FindingsStore(db, 1).list()
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
  })
})
