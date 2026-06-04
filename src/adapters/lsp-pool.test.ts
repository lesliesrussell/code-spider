// code-spider-0pa
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from '../services/indexer'
import { SemanticEnricher } from '../services/semantic-enricher'
import { AnalyzerRunner } from '../services/analyzer-runner'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

// Several files, each with one symbol that references the next file's
// symbol — many reference queries against one server.
function makeRepo(fileCount: number): string {
  const root = mkdtempSync(join(tmpdir(), 'lsp-pool-'))
  tempDirs.push(root)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
  for (let i = 0; i < fileCount; i++) {
    writeFileSync(join(root, 'src', `f${i}.ts`), `export function fn${i}(): number {\n  return ${i}\n}`)
  }
  return root
}

// Logs every `initialize` to spawnLog (one line per spawn). documentSymbol
// returns fn<i> for f<i>.ts; references always returns declaration + one
// usage in the next file. If crashAfterRefs > 0, the server exits after
// that many references responses.
function writeFakeServer(spawnLog: string, fileCount: number, crashAfterRefs = 0): string {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-pool-server-'))
  tempDirs.push(dir)
  const serverPath = join(dir, 'server.js')
  writeFileSync(serverPath, `
const fs = require('node:fs')
let buf = ''
let refsServed = 0
const CRASH_AFTER = ${crashAfterRefs}
function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write('Content-Length: ' + Buffer.byteLength(body) + '\\r\\n\\r\\n' + body)
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
    if (msg.method === 'initialize') {
      fs.appendFileSync(${JSON.stringify(spawnLog)}, 'initialize\\n')
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
      continue
    }
    if (msg.method === 'initialized') continue
    if (msg.method === 'textDocument/documentSymbol') {
      const uri = msg.params?.textDocument?.uri ?? ''
      const fileMatch = /\\/src\\/f(\\d+)\\.ts$/.exec(uri)
      let result = []
      if (fileMatch) {
        const i = Number(fileMatch[1])
        result = [{ name: 'fn' + i, kind: 12, location: { uri, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } } }, selectionRange: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } }]
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
      continue
    }
    if (msg.method === 'textDocument/references') {
      const uri = msg.params?.textDocument?.uri ?? ''
      const fileMatch = /\\/src\\/f(\\d+)\\.ts$/.exec(uri)
      let result = []
      if (fileMatch) {
        const i = Number(fileMatch[1])
        const next = (i + 1) % ${fileCount}
        const base = uri.replace(/\\/src\\/f\\d+\\.ts$/, '') + '/src'
        result = [
          { uri: base + '/f' + i + '.ts', range: { start: { line: 0, character: 16 }, end: { line: 0, character: 19 } } },
          { uri: base + '/f' + next + '.ts', range: { start: { line: 1, character: 9 }, end: { line: 1, character: 12 } } },
        ]
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
      refsServed++
      if (CRASH_AFTER > 0 && refsServed >= CRASH_AFTER) process.exit(1)
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
  }
}

async function enrich(root: string, serverPath: string) {
  const dbPath = join(root, '.code-spider', 'index.db')
  const indexResult = await new Indexer().run({ repoRoot: root, dbPath })
  const result = await new SemanticEnricher(
    new AnalyzerRunner({ registry: makeRegistry(serverPath), commandExists: () => true })
  ).run({ repoRoot: root, runId: indexResult.runId, dbPath })
  return { dbPath, runId: indexResult.runId, result }
}

describe('pooled LSP reference sessions', () => {
  test('many reference queries reuse one server process', async () => {
    const root = makeRepo(6)
    const spawnLog = join(root, 'spawns.log')
    writeFileSync(spawnLog, '')
    const { result } = await enrich(root, writeFakeServer(spawnLog, 6))

    // 6 files x 1 symbol = 6 reference queries; edges land
    expect(result.symbolEdgesAdded).toBeGreaterThanOrEqual(6)
    const referenceSpawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length
    // documentSymbol sessions during enrichment still spawn per file (out of
    // scope); the REFERENCE pass must add exactly ONE more spawn, so total
    // spawns = files (symbols) + 1, not files + queries.
    expect(referenceSpawns).toBe(6 + 1)
  })

  test('a crashed pooled session falls back per-call and enrichment completes', async () => {
    const root = makeRepo(4)
    const spawnLog = join(root, 'spawns.log')
    writeFileSync(spawnLog, '')
    // Pooled server dies after serving 2 reference responses; fallback
    // spawns take over for the remaining queries.
    const { result } = await enrich(root, writeFakeServer(spawnLog, 4, 2))

    expect(result.symbolEdgesAdded).toBeGreaterThanOrEqual(4)
    const spawns = readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean).length
    // 4 documentSymbol spawns + 1 pooled (crashed) + fallbacks for the
    // remaining ~2 queries: more than the pooled-only count, bounded above
    // by per-query spawning.
    expect(spawns).toBeGreaterThan(5)
    expect(spawns).toBeLessThanOrEqual(4 + 1 + 2)
  })
})
