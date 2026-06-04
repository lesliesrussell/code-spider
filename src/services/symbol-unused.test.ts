// code-spider-9cg
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { SemanticEnricher } from './semantic-enricher'
import { AnalyzerRunner } from './analyzer-runner'
import { SymbolUnusedAnalyzer } from './symbol-unused'
import { FindingsStore } from './findings'
import { openDb } from '../db/init'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// Repo: service.ts exports UsedService (referenced from consumer.ts),
// exports UnusedHelper (only its own declaration comes back from refs), and
// declares a non-exported internalScratch that nothing references.
function makeRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'symbol-unused-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
  writeFileSync(
    join(root, 'src', 'service.ts'),
    [
      'export class UsedService {',
      '  run(): string { return "ok" }',
      '}',
      'export function UnusedHelper(): number {',
      '  return 1',
      '}',
      'function internalScratch(): number {',
      '  return 2',
      '}',
    ].join('\n')
  )
  writeFileSync(join(root, 'src', 'consumer.ts'), "import { UsedService } from './service'\nexport const s = new UsedService()")
  return root
}

// documentSymbol gives three symbols in service.ts with selection ranges at
// their name positions; references respond per position:
//   UsedService (1:13)   -> declaration + consumer.ts usage
//   UnusedHelper (3:16)  -> declaration only
//   internalScratch (6:9)-> declaration only
function writeFakeServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'symbol-unused-lsp-'))
  tempDirs.push(dir)
  const serverPath = join(dir, 'server.js')
  writeFileSync(serverPath, `
let buf = ''
function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
}
function sym(uri, name, startLine, startChar, endLine) {
  return { name, kind: 12, location: { uri, range: { start: { line: startLine, character: 0 }, end: { line: endLine, character: 1 } } }, selectionRange: { start: { line: startLine, character: startChar }, end: { line: startLine, character: startChar + name.length } } }
}
process.stdin.on('data', chunk => {
  buf += chunk.toString()
  while (true) {
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) break
    const m = /Content-Length:\\s*(\\d+)/i.exec(buf.slice(0, headerEnd))
    if (!m) { buf = buf.slice(headerEnd + 4); continue }
    const len = Number(m[1])
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
        result = [
          sym(uri, 'UsedService', 0, 13, 2),
          sym(uri, 'UnusedHelper', 3, 16, 5),
          sym(uri, 'internalScratch', 6, 9, 8),
        ]
      } else if (uri.endsWith('/src/consumer.ts')) {
        result = [sym(uri, 's', 1, 13, 1)]
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
      continue
    }
    if (msg.method === 'textDocument/references') {
      const uri = msg.params?.textDocument?.uri ?? ''
      const pos = msg.params?.position ?? {}
      let result = []
      if (uri.endsWith('/src/service.ts')) {
        const base = uri.replace(/\\/src\\/service\\.ts$/, '') + '/src'
        if (pos.line === 0 && pos.character === 13) {
          result = [
            { uri: base + '/service.ts', range: { start: { line: 0, character: 13 }, end: { line: 0, character: 24 } } },
            { uri: base + '/consumer.ts', range: { start: { line: 1, character: 27 }, end: { line: 1, character: 38 } } },
          ]
        } else if (pos.line === 3 && pos.character === 16) {
          result = [{ uri: base + '/service.ts', range: { start: { line: 3, character: 16 }, end: { line: 3, character: 28 } } }]
        } else if (pos.line === 6 && pos.character === 9) {
          result = [{ uri: base + '/service.ts', range: { start: { line: 6, character: 9 }, end: { line: 6, character: 24 } } }]
        }
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

const REGISTRY = (serverPath: string): AnalyzerRegistryDocument => ({
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
})

async function enrichedRepo() {
  const root = makeRepo()
  const dbPath = join(root, '.code-spider', 'index.db')
  const indexResult = await new Indexer().run({ repoRoot: root, dbPath })
  await new SemanticEnricher(
    new AnalyzerRunner({ registry: REGISTRY(writeFakeServer()), commandExists: () => true })
  ).run({ repoRoot: root, runId: indexResult.runId, dbPath })
  return { root, dbPath, runId: indexResult.runId, db: openDb(dbPath) }
}

describe('SymbolUnusedAnalyzer', () => {
  test('exported-but-unreferenced symbols flag as unused-export; internal as unused-symbol', async () => {
    const { db, runId } = await enrichedRepo()
    new SymbolUnusedAnalyzer().analyze(db, runId)

    const store = new FindingsStore(db, runId)
    const unusedExports = store.list({ ruleId: 'unused-export' })
    // UnusedHelper, plus consumer.ts's exported `s` which nothing references
    // in this fixture either — both are honest zero-reference exports.
    expect(unusedExports.map(f => f.title).sort()).toEqual(['Unused export: UnusedHelper', 'Unused export: s'])
    const helper = unusedExports.find(f => f.title.includes('UnusedHelper'))!
    expect(helper.confidence).toBe('medium')
    expect(helper.locations[0]!.path).toBe('src/service.ts')

    const unusedSymbols = store.list({ ruleId: 'unused-symbol' })
    expect(unusedSymbols).toHaveLength(1)
    expect(unusedSymbols[0]!.summary).toContain('internalScratch')
    expect(unusedSymbols[0]!.confidence).toBe('low')
  })

  test('referenced symbols are never flagged', async () => {
    const { db, runId } = await enrichedRepo()
    new SymbolUnusedAnalyzer().analyze(db, runId)
    const all = new FindingsStore(db, runId).list()
    expect(all.some(f => f.summary.includes('UsedService'))).toBe(false)
  })

  test('fingerprints anchor on symbol identity, not lines', async () => {
    const { db, runId } = await enrichedRepo()
    new SymbolUnusedAnalyzer().analyze(db, runId)
    const f = new FindingsStore(db, runId).list({ ruleId: 'unused-export' })[0]!
    // anchored on path:name — recomputable without any line numbers
    expect(f.fingerprint).toMatch(/^[0-9a-f]{16}$/)
    new SymbolUnusedAnalyzer().analyze(db, runId)
    const again = new FindingsStore(db, runId).list({ ruleId: 'unused-export' })[0]!
    expect(again.fingerprint).toBe(f.fingerprint)
    expect(again.id).toBe(f.id)
  })

  test('runs without reference data emit nothing', async () => {
    // Index only — no semantic enrichment, so no symbols and no refQuery
    // metadata anywhere.
    const root = makeRepo()
    const dbPath = join(root, '.code-spider', 'index.db')
    const indexResult = await new Indexer().run({ repoRoot: root, dbPath })
    const db = openDb(dbPath)
    new SymbolUnusedAnalyzer().analyze(db, indexResult.runId)
    expect(new FindingsStore(db, indexResult.runId).list()).toEqual([])
  })
})
