#!/usr/bin/env bun
// code-spider-e9i
// Fake LSP server for e2e tests. Speaks just enough JSON-RPC to answer the
// initialize handshake, then misbehaves according to the mode in argv[2]:
//   happy          — well-formed documentSymbol response (positive control)
//   malformed-json — frame whose body is not valid JSON, then exits
//   garbage        — raw non-LSP bytes, then exits
//   truncated      — header promising more bytes than ever arrive, then exits
//   silent         — never answers documentSymbol, exits after a beat

const mode = process.argv[2] ?? 'happy'

function frame(payload: object): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

function writeThenExit(chunk: Buffer): void {
  process.stdout.write(chunk, () => {
    setTimeout(() => process.exit(0), 25)
  })
}

let initialized = false
let buf = ''

process.stdin.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8')

  if (!initialized && buf.includes('"method":"initialize"')) {
    initialized = true
    process.stdout.write(frame({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }))
    return
  }

  if (buf.includes('"textDocument/documentSymbol"')) {
    buf = '' // don't re-trigger
    switch (mode) {
      case 'malformed-json':
        writeThenExit(Buffer.concat([Buffer.from('Content-Length: 5\r\n\r\n', 'ascii'), Buffer.from('{oops', 'utf8')]))
        return
      case 'garbage':
        writeThenExit(Buffer.from('!!!! this is not LSP traffic at all\n', 'utf8'))
        return
      case 'truncated':
        writeThenExit(Buffer.from('Content-Length: 99999\r\n\r\n{"jsonrpc":"2.0","id":2', 'utf8'))
        return
      case 'silent':
        setTimeout(() => process.exit(0), 100)
        return
      default: {
        const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
        process.stdout.write(frame({
          jsonrpc: '2.0',
          id: 2,
          result: [{ name: 'fakeSymbol', kind: 12, range, selectionRange: range }],
        }))
        return
      }
    }
  }
})
