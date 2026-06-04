// code-spider-ek5
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { ArchitectureAnalyzer, loadArchitectureOptions } from './architecture'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function seedGraph(units: Array<{ id: number; path: string }>, imports: Array<[number, number]>) {
  const dir = mkdtempSync(join(tmpdir(), 'arch-db-'))
  tempDirs.push(dir)
  const db = openDb(join(dir, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', '/repo')").run()
  const insertNode = db.prepare(
    `INSERT INTO nodes (id, run_id, kind, key, label, path, language) VALUES (?, 1, 'unit', ?, ?, ?, 'TypeScript')`
  )
  for (const u of units) insertNode.run(u.id, `unit:${u.path}`, u.path.split('/').pop() ?? u.path, u.path)
  const insertEdge = db.prepare(
    `INSERT INTO edges (run_id, from_node_id, to_node_id, kind) VALUES (1, ?, ?, 'imports')`
  )
  for (const [from, to] of imports) insertEdge.run(from, to)
  return db
}

function arch(db: ReturnType<typeof openDb>, ruleId?: string) {
  return new FindingsStore(db, 1).list(ruleId ? { ruleId } : { category: 'architecture' })
}

describe('loadArchitectureOptions', () => {
  test('parses layers and forbid rules from config.yaml', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-config-'))
    tempDirs.push(root)
    mkdirSync(join(root, '.code-spider'), { recursive: true })
    writeFileSync(
      join(root, '.code-spider', 'config.yaml'),
      `intelligence:
  architecture:
    layers:
      - [app, domain, infra]
    rules:
      - from: "src/ui/**"
        to: "src/db/**"
        kind: forbid-import
`
    )
    expect(loadArchitectureOptions(root)).toEqual({
      layers: [['app', 'domain', 'infra']],
      rules: [{ from: 'src/ui/**', to: 'src/db/**', kind: 'forbid-import' }],
    })
  })

  test('missing config yields empty options', () => {
    const root = mkdtempSync(join(tmpdir(), 'arch-config-none-'))
    tempDirs.push(root)
    expect(loadArchitectureOptions(root)).toEqual({})
  })
})

describe('ArchitectureAnalyzer forbid rules', () => {
  const options = { rules: [{ from: 'src/ui/**', to: 'src/db/**', kind: 'forbid-import' as const }] }

  test('a forbidden import is flagged with the offending edge', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/ui/view.ts' },
        { id: 2, path: 'src/db/store.ts' },
        { id: 3, path: 'src/api/handler.ts' },
      ],
      [
        [1, 2], // ui -> db: forbidden
        [3, 2], // api -> db: fine
      ]
    )
    new ArchitectureAnalyzer().analyze(db, 1, options)
    const findings = arch(db, 'forbidden-dependency')
    expect(findings).toHaveLength(1)
    const f = findings[0]!
    expect(f.locations.map(l => l.path)).toEqual(['src/ui/view.ts', 'src/db/store.ts'])
    expect(f.summary).toContain('src/ui/**')
  })

  test('allowed edges produce no findings', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/api/handler.ts' },
        { id: 2, path: 'src/db/store.ts' },
      ],
      [[1, 2]]
    )
    new ArchitectureAnalyzer().analyze(db, 1, options)
    expect(arch(db)).toEqual([])
  })
})

describe('ArchitectureAnalyzer layers', () => {
  const options = { layers: [['app', 'domain', 'infra']] }
  const units = [
    { id: 1, path: 'src/app/main.ts' },
    { id: 2, path: 'src/domain/model.ts' },
    { id: 3, path: 'src/infra/db.ts' },
  ]

  test('downward imports are allowed', () => {
    const db = seedGraph(units, [
      [1, 2], // app -> domain
      [1, 3], // app -> infra
      [2, 3], // domain -> infra
    ])
    new ArchitectureAnalyzer().analyze(db, 1, options)
    expect(arch(db)).toEqual([])
  })

  test('upward imports are layering violations', () => {
    const db = seedGraph(units, [
      [3, 1], // infra -> app
      [2, 1], // domain -> app
      [1, 2], // app -> domain (fine)
    ])
    new ArchitectureAnalyzer().analyze(db, 1, options)
    const findings = arch(db, 'layering-violation')
    expect(findings).toHaveLength(2)
    const pairs = findings.map(f => f.locations.map(l => l.path).join(' -> ')).sort()
    expect(pairs).toEqual([
      'src/domain/model.ts -> src/app/main.ts',
      'src/infra/db.ts -> src/app/main.ts',
    ])
  })

  test('units outside any layer are ignored', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/infra/db.ts' },
        { id: 2, path: 'scripts/tool.ts' },
      ],
      [[1, 2], [2, 1]]
    )
    new ArchitectureAnalyzer().analyze(db, 1, options)
    expect(arch(db)).toEqual([])
  })
})

describe('ArchitectureAnalyzer determinism', () => {
  test('no config degrades to zero findings; re-runs are idempotent', () => {
    const db = seedGraph(
      [
        { id: 1, path: 'src/ui/view.ts' },
        { id: 2, path: 'src/db/store.ts' },
      ],
      [[1, 2]]
    )
    const analyzer = new ArchitectureAnalyzer()
    analyzer.analyze(db, 1, {})
    expect(arch(db)).toEqual([])

    const options = { rules: [{ from: 'src/ui/**', to: 'src/db/**', kind: 'forbid-import' as const }] }
    analyzer.analyze(db, 1, options)
    const first = arch(db)
    analyzer.analyze(db, 1, options)
    const second = arch(db)
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
    expect(second.map(f => f.fingerprint)).toEqual(first.map(f => f.fingerprint))
  })
})
