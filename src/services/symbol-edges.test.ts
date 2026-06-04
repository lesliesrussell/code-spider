// code-spider-0pi
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { SemanticEnricher } from './semantic-enricher'
import { AnalyzerRunner } from './analyzer-runner'
import { openDb } from '../db/init'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function copyFixture(name: string): string {
  const target = mkdtempSync(join(tmpdir(), `symbol-edges-${name}-`))
  tempDirs.push(target)
  const source = resolve('test', 'fixtures', name)
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
  return target
}

// Fake LSP: service.ts declares ExampleService (symbol range starting 0:0);
// consumer.ts declares consumeExample (lines 0-3) and references
// ExampleService at 0:9. references for ExampleService also include its own
// declaration — the analyzer must not emit a self-edge for it.
function writeFakeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symbol-edges-lsp-'))
  tempDirs.push(dir)
  const serverPath = join(dir, 'server.js')
  writeFileSync(serverPath, `
let buf = ''
function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
process.stdin.on('data', chunk => {
  buf += chunk.toString()
  while (true) {
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) break
    const lenMatch = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, headerEnd))
    if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue }
    const len = Number(lenMatch[1])
    if (buf.length < headerEnd + 4 + len) break
    const body = buf.slice(headerEnd + 4, headerEnd + 4 + len)
    buf = buf.slice(headerEnd + 4 + len)
    let msg
    try { msg = JSON.parse(body) } catch { continue }

    if (msg.method === 'initialize') { send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } }); continue }
    if (msg.method === 'initialized') continue
    if (msg.method === 'textDocument/documentSymbol') {
      const uri = msg.params?.textDocument?.uri ?? ''
      let result = []
      if (uri.endsWith('/src/service.ts')) {
        result = [{ name: 'ExampleService', kind: 5, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } } } }]
      } else if (uri.endsWith('/src/consumer.ts')) {
        result = [{ name: 'consumeExample', kind: 12, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } } } }]
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
      continue
    }
    if (msg.method === 'textDocument/references') {
      const uri = msg.params?.textDocument?.uri ?? ''
      const pos = msg.params?.position ?? {}
      let result = []
      // The TS plugin synthesizes a selectionRange at the symbol name, so
      // the edge pass queries at the name position (0:13), not range start.
      if (uri.endsWith('/src/service.ts') && pos.line === 0 && pos.character === 13) {
        const base = uri.replace(/\\/src\\/service\\.ts$/, '') + '/src'
        result = [
          { uri: base + '/service.ts', range: { start: { line: 0, character: 13 }, end: { line: 0, character: 27 } } },
          { uri: base + '/consumer.ts', range: { start: { line: 0, character: 9 }, end: { line: 0, character: 23 } } },
        ]
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
      continue
    }
    if (msg.method === 'shutdown') { send({ jsonrpc: '2.0', id: msg.id, result: null }); continue }
    if (msg.method === 'exit') process.exit(0)
  }
})
`)
  return serverPath
}

function makeRegistry(serverPath: string): AnalyzerRegistryDocument {
  return {
    version: 1,
    capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
    languages: [
      {
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'], manifests: ['package.json', 'tsconfig.json'] },
        analyzers: [
          {
            id: 'fixture-lsp',
            kind: 'lsp',
            tool: 'node',
            command: [process.execPath, serverPath],
            capabilities: ['symbols', 'refs'],
            priority: 100,
          },
        ],
      },
    ],
  }
}

describe('symbol edge population', () => {
  test('--semantic enrichment writes references edges between symbols', async () => {
    const repoRoot = copyFixture('typescript-cross-file')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const indexResult = await new Indexer().run({ repoRoot, dbPath })

    const enrich = await new SemanticEnricher(
      new AnalyzerRunner({ registry: makeRegistry(writeFakeServer()), commandExists: () => true })
    ).run({ repoRoot, runId: indexResult.runId, dbPath })
    expect(enrich.symbolsAdded).toBeGreaterThan(0)
    expect(enrich.symbolEdgesAdded).toBe(1)

    const db = openDb(dbPath)
    const edges = db
      .query(
        `SELECT sf.symbol_key AS fromKey, st.symbol_key AS toKey, se.kind
         FROM symbol_edges se
         JOIN symbols sf ON se.from_symbol_id = sf.id
         JOIN symbols st ON se.to_symbol_id = st.id
         WHERE se.run_id = ?`
      )
      .all(indexResult.runId) as Array<{ fromKey: string; toKey: string; kind: string }>
    db.close()

    expect(edges).toEqual([
      { fromKey: 'src/consumer.ts:consumeExample', toKey: 'src/service.ts:ExampleService', kind: 'references' },
    ])
  })

  test('a fresh re-index produces the identical edge set', async () => {
    const repoRoot = copyFixture('typescript-cross-file')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const registry = makeRegistry(writeFakeServer())

    const indexAndEnrich = async () => {
      const indexResult = await new Indexer().run({ repoRoot, dbPath })
      await new SemanticEnricher(new AnalyzerRunner({ registry, commandExists: () => true })).run({
        repoRoot,
        runId: indexResult.runId,
        dbPath,
      })
      const db = openDb(dbPath)
      const edges = db
        .query(
          `SELECT sf.symbol_key AS fromKey, st.symbol_key AS toKey, se.kind
           FROM symbol_edges se
           JOIN symbols sf ON se.from_symbol_id = sf.id
           JOIN symbols st ON se.to_symbol_id = st.id
           WHERE se.run_id = ? ORDER BY fromKey, toKey`
        )
        .all(indexResult.runId)
      db.close()
      return edges
    }

    const first = await indexAndEnrich()
    const second = await indexAndEnrich()
    expect(first).toHaveLength(1)
    expect(second).toEqual(first)
  })

  test('reference failures degrade per symbol without aborting enrichment', async () => {
    const repoRoot = copyFixture('typescript-cross-file')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const indexResult = await new Indexer().run({ repoRoot, dbPath })

    // Heuristic-only registry: symbols come from the builtin fallback, refs
    // capability is absent entirely — enrichment must still succeed.
    const registry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [
        {
          id: 'typescript',
          display_name: 'TypeScript',
          aliases: ['ts'],
          detect: { extensions: ['.ts'], manifests: ['package.json'] },
          analyzers: [
            {
              id: 'ts-basic-heuristic',
              kind: 'heuristic',
              tool: 'builtin',
              command: ['heuristic-symbols'],
              capabilities: ['symbols'],
              priority: 10,
            },
          ],
        },
      ],
    }
    const enrich = await new SemanticEnricher(
      new AnalyzerRunner({ registry, commandExists: () => false })
    ).run({ repoRoot, runId: indexResult.runId, dbPath })
    expect(enrich.symbolsAdded).toBeGreaterThan(0)
    expect(enrich.symbolEdgesAdded).toBe(0)
  })
})
