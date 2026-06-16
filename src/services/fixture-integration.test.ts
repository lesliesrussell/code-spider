import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Indexer } from './indexer'
import { SemanticEnricher } from './semantic-enricher'
import { openDb } from '../db/init'
import { SemanticQueryService } from './semantic-query'
import { AnalyzerRunner } from './analyzer-runner'
import type { AnalyzerRegistryDocument } from '../analyzer-registry'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function copyFixture(name: string): string {
  const target = mkdtempSync(join(tmpdir(), `code-spider-fixture-${name}-`))
  tempDirs.push(target)
  const source = resolve('test', 'fixtures', name)
  for (const entry of readdirSync(source)) {
    cpSync(join(source, entry), join(target, entry), { recursive: true })
  }
  return target
}

function writeFakeRefsServer(): string {
  const dir = mkdtempSync(join(tmpdir(), 'code-spider-fixture-lsp-'))
  tempDirs.push(dir)
  const serverPath = join(dir, 'server.js')
  writeFileSync(serverPath, `
let initialized = false
let buf = ''

function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`)
}

function serviceSymbols(uri) {
  return [{
    name: 'ExampleService',
    kind: 5,
    location: {
      uri,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 4, character: 1 },
      },
    },
  }]
}

function refsForService(repoRoot) {
  const base = 'file://' + repoRoot + '/src'
  return [
    {
      uri: base + '/service.ts',
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 27 },
      },
    },
    {
      uri: base + '/consumer.ts',
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 23 },
      },
    },
    {
      uri: base + '/consumer.test.ts',
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 23 },
      },
    },
  ]
}

process.stdin.on('data', chunk => {
  buf += chunk.toString()
  while (true) {
    const headerEnd = buf.indexOf('\\r\\n\\r\\n')
    if (headerEnd === -1) break
    const header = buf.slice(0, headerEnd)
    const lenMatch = /Content-Length:\\s*(\\d+)/i.exec(header)
    if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue }
    const len = Number(lenMatch[1])
    const bodyStart = headerEnd + 4
    if (buf.length < bodyStart + len) break
    const body = buf.slice(bodyStart, bodyStart + len)
    buf = buf.slice(bodyStart + len)

    let msg
    try { msg = JSON.parse(body) } catch { continue }

    if (msg.method === 'initialize') {
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
      continue
    }

    if (msg.method === 'initialized') {
      initialized = true
      continue
    }

    if (msg.method === 'textDocument/documentSymbol') {
      const uri = msg.params?.textDocument?.uri ?? ''
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: initialized && uri.endsWith('/src/service.ts') ? serviceSymbols(uri) : [],
      })
      continue
    }

    if (msg.method === 'textDocument/references') {
      const uri = msg.params?.textDocument?.uri ?? ''
      const position = msg.params?.position ?? {}
      const repoRoot = uri.replace(/\\/src\\/service\\.ts$/, '').replace(/^file:\\/\\//, '')
      const result = initialized && uri.endsWith('/src/service.ts') && position.line === 0 && position.character === 13
        ? refsForService(repoRoot)
        : []
      send({ jsonrpc: '2.0', id: msg.id, result })
      continue
    }

    if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null })
      continue
    }

    if (msg.method === 'exit') {
      process.exit(0)
    }
  }
})
`)
  return serverPath
}


describe('fixture-backed semantic integration', () => {
  test('indexes and semantically enriches a TypeScript fixture repo', async () => {
    const repoRoot = copyFixture('typescript-mini')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    expect(indexResult.fileCount).toBeGreaterThanOrEqual(3)

    const heuristicRegistry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'], manifests: ['package.json', 'tsconfig.json'] },
        analyzers: [{
          id: 'ts-basic-heuristic',
          kind: 'heuristic',
          tool: 'builtin',
          command: ['heuristic-symbols'],
          capabilities: ['symbols'],
          priority: 10,
        }],
      }],
    }

    const enrichResult = await new SemanticEnricher(new AnalyzerRunner({
      registry: heuristicRegistry,
      commandExists: () => false,
    })).run({
      repoRoot,
      runId: indexResult.runId,
      dbPath,
    })
    expect(enrichResult.filesProcessed).toBeGreaterThanOrEqual(1)
    expect(enrichResult.symbolsAdded).toBeGreaterThan(0)

    const db = openDb(dbPath)
    const query = new SemanticQueryService(db, indexResult.runId)

    const defs = query.findDefinitions('ExampleService')
    expect(defs.length).toBeGreaterThan(0)
    expect(defs[0]?.path).toBe('src/index.ts')

    const indexedRefs = query.findIndexedReferences('ExampleService')
    expect(indexedRefs.length).toBeGreaterThan(0)
    expect(indexedRefs.some(ref => ref.path === 'src/index.ts')).toBe(true)

    const coverageRows = db.query<{ capability: string; status: string; count: number }, [number]>(
      `SELECT capability, status, COUNT(*) as count
       FROM analyzer_runs
       WHERE run_id=?
       GROUP BY capability, status`
    ).all(indexResult.runId)

    expect(coverageRows.some(row => row.capability === 'symbols' && row.status === 'success')).toBe(true)
  })

  // code-spider-ab9
  test('attributes token rollups to zone and repo nodes at index time', async () => {
    // typescript-cross-file has 3 files under src/, so detectZones emits a `src` zone.
    const repoRoot = copyFixture('typescript-cross-file')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    const db = openDb(dbPath)

    // A zone node should carry a positive token rollup.
    const zoneTokens = db.query<{ value: number }, [number]>(
      `SELECT s.value AS value
       FROM stats s JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND n.kind='zone' AND s.metric='tokens'
       ORDER BY s.value DESC`
    ).all(indexResult.runId)
    expect(zoneTokens.length).toBeGreaterThan(0)
    expect(zoneTokens[0]?.value).toBeGreaterThan(0)

    // The repo node's token rollup must equal the run's corpus_ingested_tokens.
    const repoTokens = db.query<{ value: number }, [number]>(
      `SELECT s.value AS value
       FROM stats s JOIN nodes n ON n.id = s.node_id
       WHERE s.run_id=? AND n.kind='repo' AND s.metric='tokens'`
    ).get(indexResult.runId)
    const runRow = db.query<{ corpus_ingested_tokens: number | null }, [number]>(
      'SELECT corpus_ingested_tokens FROM runs WHERE id=?'
    ).get(indexResult.runId)
    expect(repoTokens?.value).toBeGreaterThan(0)
    expect(repoTokens?.value).toBe(runRow?.corpus_ingested_tokens ?? -1)
  })

  test('detects Zig fixture files and manifests as Zig instead of Other', async () => {
    const repoRoot = copyFixture('zig-mini')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    const db = openDb(dbPath)

    const languages = db.query<{ language: string; count: number }, [number]>(
      `SELECT language, COUNT(*) as count
       FROM nodes
       WHERE run_id=? AND kind='unit'
       GROUP BY language
       ORDER BY count DESC`
    ).all(indexResult.runId)

    const manifests = db.query<{ source: string; snippet: string | null }, [number]>(
      `SELECT source, snippet
       FROM evidence
       WHERE run_id=? AND kind='manifest'
       ORDER BY source ASC`
    ).all(indexResult.runId)

    expect(languages.some(row => row.language === 'Zig')).toBe(true)
    expect(manifests.some(row => row.snippet === 'build.zig')).toBe(true)
    expect(manifests.some(row => row.snippet === 'build.zig.zon')).toBe(true)
  })

  test('finds cross-file TypeScript references from fixture definitions', async () => {
    const repoRoot = copyFixture('typescript-cross-file')
    const dbPath = join(repoRoot, '.code-spider', 'index.db')
    const serverPath = writeFakeRefsServer()

    const indexResult = await new Indexer().run({ repoRoot, dbPath })
    const registry: AnalyzerRegistryDocument = {
      version: 1,
      capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
      languages: [{
        id: 'typescript',
        display_name: 'TypeScript',
        aliases: ['ts'],
        detect: { extensions: ['.ts'], manifests: ['package.json', 'tsconfig.json'] },
        analyzers: [{
          id: 'fixture-lsp',
          kind: 'lsp',
          tool: 'node',
          command: [process.execPath, serverPath],
          capabilities: ['symbols', 'refs'],
          priority: 100,
        }],
      }],
    }

    const runner = new AnalyzerRunner({
      registry,
      commandExists: () => true,
    })

    const enrichResult = await new SemanticEnricher(runner).run({
      repoRoot,
      runId: indexResult.runId,
      dbPath,
    })

    expect(enrichResult.symbolsAdded).toBeGreaterThan(0)

    const db = openDb(dbPath)
    const query = new SemanticQueryService(db, indexResult.runId)
    const definitions = query.findReferenceSeedDefinitions('ExampleService')
    expect(definitions).toHaveLength(1)
    expect(definitions[0]?.path).toBe('src/service.ts')
    expect(definitions[0]?.anchorColumn).toBeGreaterThan(0)

    const result = await runner.executeReferences({
      db,
      runId: indexResult.runId,
      nodeId: definitions[0]!.nodeId,
      filePath: join(repoRoot, definitions[0]!.path!),
      repoRoot,
      language: definitions[0]!.language ?? 'TypeScript',
      target: definitions[0]!.path!,
      position: {
        line: definitions[0]!.anchorLine!,
        character: definitions[0]!.anchorColumn!,
      },
    })

    const paths = new Set(result.locations.map(location => location.path.replace(`${repoRoot}/`, '')))
    expect(paths.has('src/service.ts')).toBe(true)
    expect(paths.has('src/consumer.ts')).toBe(true)
    expect(paths.has('src/consumer.test.ts')).toBe(true)
  })

})
