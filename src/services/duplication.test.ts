// code-spider-9kx
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { tokenize, DuplicationAnalyzer, loadDuplicationOptions } from './duplication'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('tokenize', () => {
  test('drops comments and whitespace, keeps code tokens with line numbers', () => {
    const tokens = tokenize(`// leading comment
const a = 1 /* inline */ + 2
/* block
   spanning */
const b = 'str ing'
`)
    expect(tokens.map(t => t.text)).toEqual(['const', 'a', '=', '1', '+', '2', 'const', 'b', '=', "'str ing'"])
    expect(tokens[0]!.line).toBe(2)
    expect(tokens.at(-1)!.line).toBe(5)
  })

  test('strings with escapes and template literals are single tokens', () => {
    const tokens = tokenize('const s = "a\\"b"\nconst t = `x${y}z`')
    expect(tokens.map(t => t.text)).toContain('"a\\"b"')
    expect(tokens.map(t => t.text)).toContain('`x${y}z`')
  })
})

// Generates a function body with exactly n statement-tokens worth of unique
// code so tests can control shared-region sizes precisely.
function lines(prefix: string, n: number): string {
  return Array.from({ length: n }, (_, i) => `const ${prefix}${i} = ${i}`).join('\n')
}

function seedRepo(files: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'duplication-'))
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
    insertNode.run(`unit:${rel}`, rel.split('/').pop() ?? rel, rel)
  }
  return { root, db }
}

function dupes(db: ReturnType<typeof openDb>, ruleId: string) {
  return new FindingsStore(db, 1).list({ ruleId })
}

describe('DuplicationAnalyzer', () => {
  test('identical files yield duplicate-file, not duplicate-region', async () => {
    const body = lines('x', 30)
    const { db } = seedRepo({ 'src/a.ts': body, 'src/b.ts': body, 'src/c.ts': lines('z', 30) })
    await new DuplicationAnalyzer().analyze(db, 1)

    const files = dupes(db, 'duplicate-file')
    expect(files).toHaveLength(1)
    expect(files[0]!.locations.map(l => l.path)).toEqual(['src/a.ts', 'src/b.ts'])
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })

  test('a shared region above the token threshold is reported with line spans', async () => {
    const shared = lines('s', 12) // 12 statements x 5 tokens = 60 tokens
    const { db } = seedRepo({
      'src/a.ts': `${lines('a', 5)}\n${shared}\n${lines('aa', 5)}`,
      'src/b.ts': `${lines('b', 9)}\n${shared}\n${lines('bb', 2)}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40 })

    const regions = dupes(db, 'duplicate-region')
    expect(regions).toHaveLength(1)
    const r = regions[0]!
    expect(r.locations.map(l => l.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    const a = r.locations.find(l => l.path === 'src/a.ts')!
    expect(a.line).toBe(6) // shared block starts after 5 unique lines
    expect(r.metrics?.['tokens']).toBeGreaterThanOrEqual(40)
  })

  test('shared regions below the threshold are ignored', async () => {
    const shared = lines('s', 6) // 30 tokens < 40
    const { db } = seedRepo({
      'src/a.ts': `${lines('a', 5)}\n${shared}`,
      'src/b.ts': `${lines('b', 5)}\n${shared}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40 })
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })

  test('strict mode: a single differing token splits the match', async () => {
    // Two 6-statement halves around one differing statement: each half is
    // 30 tokens, below the 40-token window, so strict mode reports nothing.
    const half1 = lines('p', 6)
    const half2 = lines('q', 6)
    const { db } = seedRepo({
      'src/a.ts': `${half1}\nconst mid = 111\n${half2}`,
      'src/b.ts': `${half1}\nconst mid = 222\n${half2}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40 })
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })

  test('minTokens config lowers the detection threshold', async () => {
    const shared = lines('s', 6) // 30 tokens
    const { db } = seedRepo({
      'src/a.ts': `${lines('a', 3)}\n${shared}`,
      'src/b.ts': `${lines('b', 3)}\n${shared}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 20 })
    expect(dupes(db, 'duplicate-region')).toHaveLength(1)
  })

  test('re-running is idempotent with identical fingerprints', async () => {
    const body = lines('x', 30)
    const { db } = seedRepo({ 'src/a.ts': body, 'src/b.ts': body })
    const analyzer = new DuplicationAnalyzer()
    await analyzer.analyze(db, 1)
    const first = dupes(db, 'duplicate-file')
    await analyzer.analyze(db, 1)
    const second = dupes(db, 'duplicate-file')
    expect(second.map(f => f.id)).toEqual(first.map(f => f.id))
    expect(second.map(f => f.fingerprint)).toEqual(first.map(f => f.fingerprint))
  })

  test('unreadable files fail soft', async () => {
    const body = lines('x', 30)
    const { db } = seedRepo({ 'src/a.ts': body, 'src/b.ts': body })
    // A node whose file does not exist on disk
    db.query(
      `INSERT INTO nodes (run_id, kind, key, label, path, language) VALUES (1, 'unit', 'unit:src/ghost.ts', 'ghost.ts', 'src/ghost.ts', 'TypeScript')`
    ).run()
    await new DuplicationAnalyzer().analyze(db, 1)
    expect(dupes(db, 'duplicate-file')).toHaveLength(1)
  })
})

// code-spider-5jd
describe('normalized mode', () => {
  test('blocks differing only in literals match in normalized mode, not strict', async () => {
    // Same shape, different string/number literals.
    const blockA = Array.from({ length: 12 }, (_, i) => `const s${i} = 'alpha${i}' + ${i * 7}`).join('\n')
    const blockB = Array.from({ length: 12 }, (_, i) => `const s${i} = 'omega${i}' + ${i * 13}`).join('\n')
    const make = () =>
      seedRepo({
        'src/a.ts': `${lines('a', 5)}\n${blockA}`,
        'src/b.ts': `${lines('b', 5)}\n${blockB}`,
      })

    const strict = make()
    await new DuplicationAnalyzer().analyze(strict.db, 1, { minTokens: 40, mode: 'strict' })
    expect(dupes(strict.db, 'duplicate-region')).toEqual([])

    const normalized = make()
    await new DuplicationAnalyzer().analyze(normalized.db, 1, { minTokens: 40, mode: 'normalized' })
    const regions = dupes(normalized.db, 'duplicate-region')
    expect(regions).toHaveLength(1)
    expect(regions[0]!.confidence).toBe('medium')
  })

  test('identifier changes still split matches in normalized mode', async () => {
    const blockA = Array.from({ length: 12 }, (_, i) => `const left${i} = ${i}`).join('\n')
    const blockB = Array.from({ length: 12 }, (_, i) => `const right${i} = ${i}`).join('\n')
    const { db } = seedRepo({
      'src/a.ts': `${lines('a', 5)}\n${blockA}`,
      'src/b.ts': `${lines('b', 5)}\n${blockB}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40, mode: 'normalized' })
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })
})

// code-spider-5jd
describe('clone classes', () => {
  test('a block shared by three files becomes one clone-class, not pairwise regions', async () => {
    const shared = lines('s', 12)
    const { db } = seedRepo({
      'src/a.ts': `${lines('a', 5)}\n${shared}`,
      'src/b.ts': `${lines('b', 7)}\n${shared}`,
      'src/c.ts': `${lines('c', 3)}\n${shared}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40 })
    const classes = dupes(db, 'clone-class')
    expect(classes).toHaveLength(1)
    expect(classes[0]!.locations.map(l => l.path).sort()).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts'])
    expect(classes[0]!.metrics?.['files']).toBe(3)
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })

  test('a clone spanning zones is reported as cross-package-duplication', async () => {
    const shared = lines('s', 12)
    const { db } = seedRepo({
      'backend/a.ts': `${lines('a', 5)}\n${shared}`,
      'frontend/b.ts': `${lines('b', 7)}\n${shared}`,
    })
    await new DuplicationAnalyzer().analyze(db, 1, { minTokens: 40 })
    const cross = dupes(db, 'cross-package-duplication')
    expect(cross).toHaveLength(1)
    expect(cross[0]!.metrics?.['zones']).toBe(2)
    expect(dupes(db, 'duplicate-region')).toEqual([])
  })
})

// code-spider-5jd
describe('mode config', () => {
  test('loadDuplicationOptions reads mode and min-tokens', () => {
    const root = mkdtempSync(join(tmpdir(), 'dup-config-'))
    tempDirs.push(root)
    mkdirSync(join(root, '.code-spider'), { recursive: true })
    writeFileSync(
      join(root, '.code-spider', 'config.yaml'),
      'intelligence:\n  duplication:\n    mode: normalized\n    min-tokens: 25\n'
    )
    expect(loadDuplicationOptions(root)).toEqual({ minTokens: 25, mode: 'normalized' })
  })
})
