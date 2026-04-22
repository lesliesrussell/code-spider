import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { LspAdapter, normalizeDocumentSymbolResult } from './lsp'

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

function makeTempDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${name}-`))
  tempDirs.push(dir)
  return dir
}

function writeFakeServer(mode: 'symbols' | 'refs' | 'diagnostics', outputPath: string): string {
  const scriptPath = join(makeTempDir(`code-spider-lsp-${mode}`), 'server.js')
  const script = `
const fs = require('node:fs')
const outputPath = process.argv[2]
const mode = ${JSON.stringify(mode)}
let initialized = false
let opened = false
let initRootUri = null
let buf = ''

function send(msg) {
  const body = JSON.stringify(msg)
  process.stdout.write(\`Content-Length: \${Buffer.byteLength(body)}\\r\\n\\r\\n\${body}\`)
}

function record(extra = {}) {
  fs.writeFileSync(outputPath, JSON.stringify({ initialized, opened, initRootUri, ...extra }))
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
      initRootUri = msg.params?.rootUri ?? null
      record()
      send({ jsonrpc: '2.0', id: msg.id, result: { capabilities: {} } })
      continue
    }

    if (msg.method === 'initialized') {
      initialized = true
      record()
      continue
    }

    if (msg.method === 'textDocument/didOpen') {
      opened = true
      record()
      if (mode === 'diagnostics' && initialized) {
        send({
          jsonrpc: '2.0',
          method: 'textDocument/publishDiagnostics',
          params: {
            uri: msg.params.textDocument.uri,
            diagnostics: [{
              severity: 1,
              code: 'E100',
              message: 'fake diagnostic',
              range: {
                start: { line: 2, character: 4 },
                end: { line: 2, character: 7 },
              },
            }],
          },
        })
      }
      continue
    }

    if (msg.method === 'textDocument/documentSymbol') {
      record({ requestReceived: 'documentSymbol' })
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: initialized && opened ? [{
          name: 'ExampleService',
          kind: 5,
          location: {
            uri: 'file:///tmp/example.ts',
            range: {
              start: { line: 5, character: 2 },
              end: { line: 18, character: 1 },
            },
          },
          containerName: 'ExampleModule',
        }] : null,
      })
      continue
    }

    if (msg.method === 'textDocument/references') {
      record({ requestReceived: 'references' })
      send({
        jsonrpc: '2.0',
        id: msg.id,
        result: initialized && opened ? [{
          uri: msg.params.textDocument.uri,
          range: {
            start: { line: 8, character: 6 },
            end: { line: 8, character: 21 },
          },
        }] : [],
      })
      continue
    }

    if (msg.method === 'shutdown') {
      send({ jsonrpc: '2.0', id: msg.id, result: null })
      continue
    }

    if (msg.method === 'exit') {
      record({ exited: true })
      process.exit(0)
    }
  }
})
`
  writeFileSync(scriptPath, script)
  return scriptPath
}

describe('normalizeDocumentSymbolResult', () => {
  test('normalizes SymbolInformation ranges from location.range', () => {
    const symbols = normalizeDocumentSymbolResult([{
      name: 'ExampleService',
      kind: 5,
      location: {
        uri: 'file:///tmp/example.ts',
        range: {
          start: { line: 5, character: 2 },
          end: { line: 18, character: 1 },
        },
      },
      containerName: 'ExampleModule',
    }])

    expect(symbols).toEqual([{
      name: 'ExampleService',
      kind: 5,
      kindName: 'Class',
      containerName: 'ExampleModule',
      range: {
        start: { line: 5, character: 2 },
        end: { line: 18, character: 1 },
      },
      selectionRange: undefined,
    }])
  })
})

describe('LspAdapter', () => {
  test('sends initialized before documentSymbol and uses repo root for rootUri', async () => {
    const repoRoot = makeTempDir('code-spider-lsp-symbols-repo')
    const filePath = join(repoRoot, 'example.ts')
    const statePath = join(repoRoot, 'symbols-state.json')
    writeFileSync(filePath, 'export class ExampleService {}\n')
    const serverPath = writeFakeServer('symbols', statePath)

    const result = await new LspAdapter().getSymbols(
      filePath,
      'TypeScript',
      repoRoot,
      [process.execPath, serverPath, statePath],
    )

    expect(result.error).toBeUndefined()
    expect(result.symbols).toEqual([{
      name: 'ExampleService',
      kind: 5,
      kindName: 'Class',
      containerName: 'ExampleModule',
      range: {
        start: { line: 5, character: 2 },
        end: { line: 18, character: 1 },
      },
      selectionRange: undefined,
    }])

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      initialized: boolean
      opened: boolean
      initRootUri: string | null
    }
    expect(state).toMatchObject({
      initialized: true,
      opened: true,
      initRootUri: `file://${repoRoot}`,
    })
  })

  test('sends initialized before textDocument/references', async () => {
    const repoRoot = makeTempDir('code-spider-lsp-refs-repo')
    const filePath = join(repoRoot, 'example.ts')
    const statePath = join(repoRoot, 'refs-state.json')
    writeFileSync(filePath, 'export class ExampleService {}\nnew ExampleService()\n')
    const serverPath = writeFakeServer('refs', statePath)

    const result = await new LspAdapter().getReferences(
      filePath,
      'TypeScript',
      { line: 0, character: 13 },
      repoRoot,
      [process.execPath, serverPath, statePath],
    )

    expect(result.error).toBeUndefined()
    expect(result.locations).toEqual([{
      uri: `file://${filePath}`,
      path: filePath,
      range: {
        start: { line: 8, character: 6 },
        end: { line: 8, character: 21 },
      },
    }])

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      initialized: boolean
      opened: boolean
      initRootUri: string | null
    }
    expect(state).toMatchObject({
      initialized: true,
      opened: true,
      initRootUri: `file://${repoRoot}`,
    })
  })

  test('sends initialized before diagnostics subscriptions', async () => {
    const repoRoot = makeTempDir('code-spider-lsp-diags-repo')
    const filePath = join(repoRoot, 'example.ts')
    const statePath = join(repoRoot, 'diagnostics-state.json')
    writeFileSync(filePath, 'export const answer = 42\n')
    const serverPath = writeFakeServer('diagnostics', statePath)

    const result = await new LspAdapter().getDiagnostics(
      filePath,
      'TypeScript',
      repoRoot,
      [process.execPath, serverPath, statePath],
    )

    expect(result.error).toBeUndefined()
    expect(result.diagnostics).toEqual([{
      severity: 1,
      code: 'E100',
      message: 'fake diagnostic',
      range: {
        start: { line: 2, character: 4 },
        end: { line: 2, character: 7 },
      },
    }])

    const state = JSON.parse(readFileSync(statePath, 'utf8')) as {
      initialized: boolean
      opened: boolean
      initRootUri: string | null
    }
    expect(state).toMatchObject({
      initialized: true,
      opened: true,
      initRootUri: `file://${repoRoot}`,
    })
  })
})
