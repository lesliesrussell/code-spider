// code-spider-0fy
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadEntrypointGlobs, isEntrypoint } from './entrypoints'
import { Indexer } from './indexer'
import { openDb } from '../db/init'
import type { CliContext } from '../types'
import runShow from '../commands/show'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'entrypoints-'))
  tempDirs.push(root)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, '..'), { recursive: true })
    writeFileSync(join(root, rel), content)
  }
  return root
}

const CONFIG = `intelligence:
  entrypoints:
    - src/index.ts
    - "apps/*/main.ts"
`

describe('loadEntrypointGlobs', () => {
  test('reads intelligence.entrypoints from config.yaml', () => {
    const root = makeRepo({ '.code-spider/config.yaml': CONFIG })
    expect(loadEntrypointGlobs(root)).toEqual(['src/index.ts', 'apps/*/main.ts'])
  })

  test('missing config yields empty list', () => {
    const root = makeRepo({})
    expect(loadEntrypointGlobs(root)).toEqual([])
  })
})

describe('isEntrypoint', () => {
  test('matches exact paths and glob patterns', () => {
    const globs = ['src/index.ts', 'apps/*/main.ts']
    expect(isEntrypoint(globs, 'src/index.ts')).toBe(true)
    expect(isEntrypoint(globs, 'apps/web/main.ts')).toBe(true)
    expect(isEntrypoint(globs, 'src/other.ts')).toBe(false)
    expect(isEntrypoint(globs, 'apps/web/nested/main.ts')).toBe(false)
  })
})

describe('Indexer entrypoint marking', () => {
  test('matching units carry entrypoint metadata; others do not', async () => {
    const root = makeRepo({
      '.code-spider/config.yaml': CONFIG,
      'src/index.ts': 'export {}',
      'src/other.ts': 'export {}',
    })
    const dbPath = join(root, '.code-spider', 'index.db')
    await new Indexer().run({ repoRoot: root, dbPath })

    const db = openDb(dbPath)
    const rows = db
      .query(
        `SELECT path, json_extract(metadata_json, '$.entrypoint') AS ep
         FROM nodes WHERE kind = 'unit' ORDER BY path`
      )
      .all() as Array<{ path: string; ep: number | null }>
    db.close()
    const byPath = new Map(rows.map(r => [r.path, r.ep]))
    expect(byPath.get('src/index.ts')).toBe(1)
    expect(byPath.get('src/other.ts')).toBeNull()
  })

  test('show --json exposes the entrypoint flag on the node', async () => {
    const root = makeRepo({
      '.code-spider/config.yaml': CONFIG,
      'src/index.ts': 'export {}',
    })
    const dbPath = join(root, '.code-spider', 'index.db')
    await new Indexer().run({ repoRoot: root, dbPath })

    const lines: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => {
      lines.push(args.map(a => String(a)).join(' '))
    }
    try {
      const ctx: CliContext = {
        repoRoot: root,
        dbPath,
        json: true,
        args: ['unit:src/index.ts'],
        flags: {},
      }
      await runShow(ctx)
    } finally {
      console.log = originalLog
    }
    const out = JSON.parse(lines.join('\n')) as { node: { entrypoint: number | null } }
    expect(out.node.entrypoint).toBe(1)
  })
})
