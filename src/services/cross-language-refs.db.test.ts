// code-spider-ni6
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from '../db/init'
import { applyCrossLanguageReferences } from './cross-language-refs'
import { SymbolUnusedAnalyzer } from './symbol-unused'
import { FindingsStore } from './findings'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

interface SeedSymbol {
  id: number
  nodeId: number
  name: string
  line: number
  externalRefs: number | null
}

// Build a C+Zig repo on disk plus a seeded DB: util.zig exports `xrealloc`
// (called only from C) and `orphan` (called from nowhere); util.h declares
// `xrealloc` as a C prototype.
function seedRepo() {
  const root = mkdtempSync(join(tmpdir(), 'cross-lang-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(
    join(root, 'src', 'util.zig'),
    ['export fn xrealloc(ptr: ?*anyopaque, size: usize) callconv(.C) *anyopaque {', '    return ptr;', '}', 'export fn orphan() callconv(.C) void {}'].join('\n')
  )
  writeFileSync(join(root, 'src', 'util.h'), 'void *xrealloc(void *ptr, size_t size);\n')

  const db = openDb(join(root, 'index.db'))
  db.query("INSERT INTO runs (id, started_at, repo_root) VALUES (1, 't', ?)").run(root)
  const insertNode = db.prepare(`INSERT INTO nodes (id, run_id, kind, key, label, path, language) VALUES (?, 1, 'unit', ?, ?, ?, ?)`)
  insertNode.run(10, 'unit:src/util.zig', 'util.zig', 'src/util.zig', 'Zig')
  insertNode.run(11, 'unit:src/util.h', 'util.h', 'src/util.h', 'C/C++')

  const insertSym = db.prepare(
    `INSERT INTO symbols (id, run_id, node_id, symbol_key, name, kind, range_json, selection_range_json, metadata_json)
     VALUES (?, 1, ?, ?, ?, 'Function', ?, ?, ?)`
  )
  const seed = (s: SeedSymbol, path: string, char: number) => {
    const range = JSON.stringify({ start: { line: s.line, character: 0 }, end: { line: s.line + 1, character: 1 } })
    const sel = JSON.stringify({ start: { line: s.line, character: char }, end: { line: s.line, character: char + s.name.length } })
    const meta = s.externalRefs === null ? JSON.stringify({}) : JSON.stringify({ refQuery: { externalRefs: s.externalRefs } })
    insertSym.run(s.id, s.nodeId, `${path}:${s.name}`, s.name, range, sel, meta)
  }
  seed({ id: 1, nodeId: 10, name: 'xrealloc', line: 0, externalRefs: 0 }, 'src/util.zig', 10)
  seed({ id: 2, nodeId: 10, name: 'orphan', line: 3, externalRefs: 0 }, 'src/util.zig', 10)
  seed({ id: 3, nodeId: 11, name: 'xrealloc', line: 0, externalRefs: 5 }, 'src/util.h', 6)
  return { db, root }
}

describe('applyCrossLanguageReferences', () => {
  test('Zig C-ABI export with a C twin is no longer flagged unused; the orphan still is', () => {
    const { db, root } = seedRepo()

    const edges = applyCrossLanguageReferences(db, 1, root)
    // Both directions of the ABI pair: C decl -> Zig export, and Zig export -> C decl.
    expect(edges).toBe(2)

    // The Zig export now carries a non-zero external-reference count.
    const meta = db.query<{ metadata_json: string }, [number]>('SELECT metadata_json FROM symbols WHERE id = ?').get(1)
    expect(JSON.parse(meta!.metadata_json).refQuery.externalRefs).toBeGreaterThan(0)

    // A cross-language edge from the C declaration to the Zig export was written.
    const edgeRows = db
      .query<{ from_symbol_id: number; to_symbol_id: number; kind: string }, [number]>('SELECT from_symbol_id, to_symbol_id, kind FROM symbol_edges WHERE run_id = ?')
      .all(1)
    expect(edgeRows.every(e => e.kind === 'cross-language-references')).toBe(true)
    expect(edgeRows).toContainEqual({ from_symbol_id: 3, to_symbol_id: 1, kind: 'cross-language-references' })

    new SymbolUnusedAnalyzer().analyze(db, 1)
    const findings = new FindingsStore(db, 1).list({ category: 'reachability' })
    const names = findings.map(f => f.title)
    expect(names).toContain('Unused export: orphan')
    expect(names).not.toContain('Unused export: xrealloc')
  })
})
