import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { openDb } from '../db/init'
import { Navigator } from './navigator'

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

describe('MarkdownContextIndexer', () => {
  test('creates doc and doc_section nodes and mention edges for markdown path references', async () => {
    const repoRoot = makeTempRepo('code-spider-markdown-context')
    mkdirSync(join(repoRoot, 'src'), { recursive: true })
    writeFileSync(join(repoRoot, 'src', 'index.ts'), 'export const value = 1\n')
    writeFileSync(
      join(repoRoot, 'README.md'),
      [
        '# Overview',
        '',
        'See src/index.ts for the main entrypoint.',
        '',
        '## Notes',
        '',
        '- src/index.ts contains the exported value.',
      ].join('\n'),
    )

    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const result = await new Indexer().run({ repoRoot, dbPath })
    expect(result.markdown).toEqual({
      docsAdded: 1,
      sectionsAdded: 2,
      mentionEdgesAdded: 2,
    })

    const db = openDb(dbPath)

    const docCount = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM nodes WHERE run_id=? AND kind='doc'`
    ).get(result.runId)?.count
    const sectionCount = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM nodes WHERE run_id=? AND kind='doc_section'`
    ).get(result.runId)?.count
    const mentionCount = db.query<{ count: number }, [number]>(
      `SELECT COUNT(*) as count FROM edges WHERE run_id=? AND kind='mentions'`
    ).get(result.runId)?.count
    const evidence = db.query<{ source: string; locator: string | null; snippet: string | null }, [number]>(
      `SELECT source, locator, snippet FROM evidence
       WHERE run_id=? AND kind='markdown'
       ORDER BY id ASC`
    ).all(result.runId)

    expect(docCount).toBe(1)
    expect(sectionCount).toBe(2)
    expect(mentionCount).toBe(2)
    expect(evidence.some(row => row.source === 'README.md' && row.locator === 'Overview')).toBe(true)
    expect(evidence.some(row => row.snippet?.includes('mentions src/index.ts') === true)).toBe(true)

    const runId = Navigator.latestRunId(db, repoRoot)
    expect(runId).toBe(result.runId)

    const node = new Navigator(db, result.runId).getNode('unit:src/index.ts')
    expect(node).not.toBeNull()

    const markdownContext = new Navigator(db, result.runId).getMarkdownContext(node!.id)
    expect(markdownContext).toEqual([
      {
        sectionKey: 'doc_section:README.md#notes',
        sectionTitle: 'Notes',
        sectionPath: 'README.md',
        sectionSummary: '- src/index.ts contains the exported value.',
        docKey: 'doc:README.md',
        docLabel: 'README.md',
        docPath: 'README.md',
        docSummary: null,
      },
      {
        sectionKey: 'doc_section:README.md#overview',
        sectionTitle: 'Overview',
        sectionPath: 'README.md',
        sectionSummary: 'See src/index.ts for the main entrypoint.',
        docKey: 'doc:README.md',
        docLabel: 'README.md',
        docPath: 'README.md',
        docSummary: null,
      },
    ])
  })
})
