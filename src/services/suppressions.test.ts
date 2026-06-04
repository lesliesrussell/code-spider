// code-spider-c4l
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { FindingsStore } from './findings'
import { loadSuppressions, applySuppressions } from './suppressions'
import type { SuppressionEntry } from './suppressions'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(configYaml?: string): string {
  const root = mkdtempSync(join(tmpdir(), 'suppressions-'))
  tempDirs.push(root)
  if (configYaml !== undefined) {
    mkdirSync(join(root, '.code-spider'), { recursive: true })
    writeFileSync(join(root, '.code-spider', 'config.yaml'), configYaml)
  }
  return root
}

function makeDb(root: string) {
  const db = openDb(join(root, '.code-spider', 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', ?)").run(root)
  return db
}

function addUnusedFinding(db: ReturnType<typeof openDb>, path: string): void {
  new FindingsStore(db, 1).add({
    ruleId: 'unused-file',
    category: 'reachability',
    severity: 'warning',
    confidence: 'high',
    title: `Unused file: ${path}`,
    summary: `${path} is not reachable`,
    anchor: path,
    nodeKey: `unit:${path}`,
    locations: [{ path }],
  })
}

const CONFIG = `intelligence:
  suppressions:
    - rule: unused-file
      path: "src/legacy/**"
      expires: "2099-12-31"
      owner: platform-team
      reason: migration fallback
`

describe('loadSuppressions', () => {
  test('parses structured entries from config.yaml', () => {
    const root = makeRepo(CONFIG)
    const entries = loadSuppressions(root)
    expect(entries).toEqual([
      {
        rule: 'unused-file',
        path: 'src/legacy/**',
        expires: '2099-12-31',
        owner: 'platform-team',
        reason: 'migration fallback',
      },
    ])
  })

  test('missing config or section yields empty list', () => {
    expect(loadSuppressions(makeRepo())).toEqual([])
    expect(loadSuppressions(makeRepo('ignore:\n  dirs:\n    - .git\n'))).toEqual([])
  })

  test('malformed yaml fails soft to empty list', () => {
    const root = makeRepo('intelligence:\n  suppressions: ["broken')
    expect(loadSuppressions(root)).toEqual([])
  })
})

describe('applySuppressions', () => {
  const active: SuppressionEntry = {
    rule: 'unused-file',
    path: 'src/legacy/**',
    expires: '2099-12-31',
    owner: 'platform',
    reason: 'migration',
  }

  test('matching findings are removed; non-matching survive', () => {
    const root = makeRepo()
    const db = makeDb(root)
    addUnusedFinding(db, 'src/legacy/bridge.ts')
    addUnusedFinding(db, 'src/fresh/dead.ts')

    applySuppressions(db, 1, [active])

    const remaining = new FindingsStore(db, 1).list({ ruleId: 'unused-file' })
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.locations[0]!.path).toBe('src/fresh/dead.ts')
  })

  test('an active suppression that matched emits no stale finding', () => {
    const root = makeRepo()
    const db = makeDb(root)
    addUnusedFinding(db, 'src/legacy/bridge.ts')
    applySuppressions(db, 1, [active])
    expect(new FindingsStore(db, 1).list({ ruleId: 'stale-suppression' })).toEqual([])
  })

  test('expired suppressions stop suppressing and emit stale-suppression', () => {
    const root = makeRepo()
    const db = makeDb(root)
    addUnusedFinding(db, 'src/legacy/bridge.ts')

    applySuppressions(db, 1, [{ ...active, expires: '2020-01-01' }])

    const unused = new FindingsStore(db, 1).list({ ruleId: 'unused-file' })
    expect(unused).toHaveLength(1)
    const stale = new FindingsStore(db, 1).list({ ruleId: 'stale-suppression' })
    expect(stale).toHaveLength(1)
    expect(stale[0]!.summary).toContain('expired')
  })

  test('suppressions matching nothing emit stale-suppression', () => {
    const root = makeRepo()
    const db = makeDb(root)
    addUnusedFinding(db, 'src/other/dead.ts')

    applySuppressions(db, 1, [active])

    const stale = new FindingsStore(db, 1).list({ ruleId: 'stale-suppression' })
    expect(stale).toHaveLength(1)
    expect(stale[0]!.summary).toContain('matched no findings')
  })

  test('re-applying is idempotent', () => {
    const root = makeRepo()
    const db = makeDb(root)
    addUnusedFinding(db, 'src/other/dead.ts')
    applySuppressions(db, 1, [active])
    applySuppressions(db, 1, [active])
    const stale = new FindingsStore(db, 1).list({ ruleId: 'stale-suppression' })
    expect(stale).toHaveLength(1)
  })
})
