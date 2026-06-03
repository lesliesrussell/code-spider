import { spawn } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
// code-spider-c6v
import { buildIgnoreRules, shouldIgnoreFile } from './filesystem'
// code-spider-bik
import { debugLog } from '../utils/debug'

// code-spider-gqd
// Byte-correct JSON-RPC frame parser shared by every LSP session. The LSP
// Content-Length header counts BYTES; the previous per-function string loops
// compared it against JS string length (UTF-16 code units), so any multibyte
// UTF-8 in server output sliced bodies short and corrupted every following
// frame. This parser accumulates a Buffer and only decodes complete bodies.
export class JsonRpcFrameParser {
  private buf: Buffer = Buffer.alloc(0)

  // Feed a stdout chunk; returns every complete, well-formed message it ends.
  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk])
    const messages: unknown[] = []

    while (true) {
      const headerEnd = this.buf.indexOf('\r\n\r\n')
      if (headerEnd === -1) break

      const header = this.buf.subarray(0, headerEnd).toString('utf8')
      const lenMatch = /Content-Length:\s*(\d+)/i.exec(header)
      if (!lenMatch) {
        debugLog('lsp', 'JSON-RPC header without Content-Length, skipping')
        this.buf = this.buf.subarray(headerEnd + 4)
        continue
      }

      const len = parseInt(lenMatch[1]!, 10)
      const bodyStart = headerEnd + 4
      if (this.buf.length < bodyStart + len) break

      const body = this.buf.subarray(bodyStart, bodyStart + len).toString('utf8')
      this.buf = this.buf.subarray(bodyStart + len)

      try {
        messages.push(JSON.parse(body))
      } catch (err) {
        debugLog('lsp', 'malformed JSON-RPC body', err)
      }
    }

    return messages
  }
}

export interface LspSymbol {
  name: string
  kind: number
  kindName: string
  containerName?: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
  signal?: 'low'
}

export interface LspDiagnostic {
  severity: 1 | 2 | 3 | 4
  code?: string
  message: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

export interface LspResult {
  filePath: string
  symbols: LspSymbol[]
  diagnostics: LspDiagnostic[]
  error?: string
}

export interface LspLocation {
  uri: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
}

type LspRange = LspSymbol['range']

const LSP_SYMBOL_KIND_NAMES: Record<number, string> = {
  1: 'File', 2: 'Module', 3: 'Namespace', 4: 'Package', 5: 'Class',
  6: 'Method', 7: 'Property', 8: 'Field', 9: 'Constructor', 10: 'Enum',
  11: 'Interface', 12: 'Function', 13: 'Variable', 14: 'Constant',
  15: 'String', 16: 'Number', 17: 'Boolean', 18: 'Array', 19: 'Object',
  20: 'Key', 21: 'Null', 22: 'EnumMember', 23: 'Struct', 24: 'Event',
  25: 'Operator', 26: 'TypeParameter',
}

const LOW_SIGNAL_IDENTIFIER_NAMES = new Set([
  'arg',
  'args',
  'ctx',
  'data',
  'detail',
  'entry',
  'item',
  'node',
  'options',
  'opts',
  'param',
  'params',
  'result',
  'results',
  'row',
  'rows',
  'value',
  'values',
])

const LOW_SIGNAL_IDENTIFIER_KINDS = new Set(['Constant', 'Field', 'Property', 'Variable'])

function fileUri(filePath: string): string {
  return `file://${filePath}`
}

function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri
}

// code-spider-c6v
export function collectWorkspaceFiles(repoRoot: string, extensions: string[]): string[] {
  const results: string[] = []
  const rules = buildIgnoreRules(repoRoot)

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (rules.dirNames.has(entry.name)) continue
        visit(fullPath)
        continue
      }
      if (extensions.some(ext => entry.name.endsWith(ext))) {
        if (shouldIgnoreFile(relative(repoRoot, fullPath), rules)) continue
        results.push(fullPath)
      }
    }
  }

  visit(repoRoot)
  return results
}

function isPosition(value: unknown): value is { line: number; character: number } {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return typeof candidate['line'] === 'number' && typeof candidate['character'] === 'number'
}

function isRange(value: unknown): value is LspRange {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  return isPosition(candidate['start']) && isPosition(candidate['end'])
}

function defaultRange(): LspRange {
  return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }
}

export function classifySymbolSignal(name: string, kindName: string): 'low' | undefined {
  if (!name) return undefined
  if (/[().\[\]\s]/.test(name)) return 'low'
  if (LOW_SIGNAL_IDENTIFIER_KINDS.has(kindName) && LOW_SIGNAL_IDENTIFIER_NAMES.has(name)) return 'low'
  return undefined
}

function extractSymbolRange(raw: Record<string, unknown>): LspRange {
  if (isRange(raw['range'])) return raw['range']

  const location = raw['location']
  if (typeof location === 'object' && location !== null) {
    const locationRange = (location as Record<string, unknown>)['range']
    if (isRange(locationRange)) return locationRange
  }

  return defaultRange()
}

function extractSelectionRange(raw: Record<string, unknown>): LspRange | undefined {
  return isRange(raw['selectionRange']) ? raw['selectionRange'] : undefined
}

export function normalizeDocumentSymbolResult(result: unknown): LspSymbol[] {
  if (!Array.isArray(result)) return []

  const symbols: LspSymbol[] = []

  const visit = (entry: unknown, containerName?: string): void => {
    if (typeof entry !== 'object' || entry === null) return

    const raw = entry as Record<string, unknown>
    const name = typeof raw['name'] === 'string' ? raw['name'] : ''
    const kind = typeof raw['kind'] === 'number' ? raw['kind'] : 13
    const kindName = LSP_SYMBOL_KIND_NAMES[kind] ?? 'Variable'
    const range = extractSymbolRange(raw)
    symbols.push({
      name,
      kind,
      kindName,
      containerName: typeof raw['containerName'] === 'string' ? raw['containerName'] : containerName,
      range,
      selectionRange: extractSelectionRange(raw),
      signal: classifySymbolSignal(name, kindName),
    })

    const children = raw['children']
    if (Array.isArray(children)) {
      for (const child of children) visit(child, name)
    }
  }

  for (const entry of result) visit(entry)
  return symbols
}

function inferSelectionRange(
  range: LspRange,
  name: string,
  sourceText?: string,
): LspRange | undefined {
  if (!sourceText || !name) return undefined

  const lines = sourceText.split('\n')
  const line = lines[range.start.line]
  if (line === undefined) return undefined

  const searchStart = Math.max(0, range.start.character)
  const matchIndex = line.indexOf(name, searchStart)
  if (matchIndex === -1) return undefined

  return {
    start: { line: range.start.line, character: matchIndex },
    end: { line: range.start.line, character: matchIndex + name.length },
  }
}

export function applyInferredSelectionRanges(symbols: LspSymbol[], sourceText?: string): LspSymbol[] {
  return symbols.map(symbol => {
    if (symbol.selectionRange !== undefined) return symbol
    const inferred = inferSelectionRange(symbol.range, symbol.name, sourceText)
    return inferred ? { ...symbol, selectionRange: inferred } : symbol
  })
}

// code-spider-e3d
// Registry of live LSP child processes. Each session kills its own child on
// completion/timeout/error, but nothing covered the parent dying — Ctrl-C
// mid-enrichment orphaned every in-flight language server. A single set of
// exit hooks reaps survivors.
const liveProcs = new Set<ReturnType<typeof spawn>>()
let exitHooksInstalled = false

function reapLiveProcs(): void {
  for (const proc of liveProcs) {
    try { proc.kill() } catch { /* ignore */ }
  }
  liveProcs.clear()
}

// code-spider-e3d
export function trackProc(proc: ReturnType<typeof spawn>): void {
  liveProcs.add(proc)
  proc.on('close', () => { liveProcs.delete(proc) })

  if (!exitHooksInstalled) {
    exitHooksInstalled = true
    process.on('exit', reapLiveProcs)
    process.on('SIGINT', () => { reapLiveProcs(); process.exit(130) })
    process.on('SIGTERM', () => { reapLiveProcs(); process.exit(143) })
  }
}

// code-spider-e3d (exposed for tests)
export function liveLspProcessCount(): number {
  return liveProcs.size
}

// code-spider-zex
// One LSP stdio session: spawn → initialize handshake → capability-specific
// requests → cleanup. The four capability functions used to hand-roll this
// (~100 lines each, four near-copies); they are now thin configurations of
// this runner. Per-server/per-capability tuning (timeouts, idle-finish for
// notification-driven flows, whether the target file must be readable) lives
// in the options — that is the quirk surface for differing server behavior.
interface LspSessionContext<T> {
  send: (msg: object) => void
  finish: (result: T) => void
  scheduleIdleFinish: () => void
  targetText: string
}

interface LspSessionOptions<T> {
  command: string[]
  filePath: string
  repoRoot: string
  capabilities: object
  // Overall deadline. Default 10s → resolve null. Sessions that can return
  // partial results on deadline (diagnostics) provide onTimeout.
  timeoutMs?: number
  onTimeout?: () => T
  // Debounced completion for notification-driven flows: each
  // scheduleIdleFinish() call re-arms the timer; when it fires the session
  // finishes with idleResult().
  idleFinishMs?: number
  idleResult?: () => T
  // Fail fast (with cleanup) when the target file is unreadable. Sessions
  // that send target content via other means may skip the read.
  readTargetFile?: boolean
  onInitialized: (ctx: LspSessionContext<T>) => void
  onMessage: (
    msg: { id?: number; result?: unknown; method?: string; params?: unknown },
    ctx: LspSessionContext<T>,
  ) => void
  onClose?: (initialized: boolean) => T | null
}

function runLspSession<T>(opts: LspSessionOptions<T>): Promise<T | null> {
  return new Promise((resolve) => {
    const [bin, ...args] = opts.command
    if (bin === undefined) { resolve(null); return }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
      // code-spider-e3d
      trackProc(proc)
    } catch (err) {
      // code-spider-bik
      debugLog('lsp', `failed to spawn ${bin}`, err)
      resolve(null)
      return
    }

    const timeoutMs = opts.timeoutMs ?? 10000
    let completed = false
    let initialized = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const clearTimers = (): void => {
      clearTimeout(overallTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
    }

    // Single exit path: clears timers, optionally says goodbye politely,
    // always kills, resolves exactly once.
    const complete = (result: T | null, shutdown: boolean): void => {
      if (completed) return
      completed = true
      clearTimers()
      if (shutdown) {
        send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null })
        send({ jsonrpc: '2.0', method: 'exit', params: null })
      }
      try { proc.kill() } catch { /* ignore */ }
      resolve(result)
    }

    const overallTimer = setTimeout(() => {
      if (opts.onTimeout !== undefined) {
        complete(opts.onTimeout(), true)
      } else {
        // code-spider-bik
        debugLog('lsp', `request timed out after ${timeoutMs}ms: ${opts.filePath}`)
        complete(null, false)
      }
    }, timeoutMs)

    const send = (msg: object): void => {
      const body = JSON.stringify(msg)
      proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }

    let targetText = ''
    if (opts.readTargetFile !== false) {
      try {
        targetText = readFileSync(opts.filePath, 'utf8')
      } catch (err) {
        // code-spider-bik
        // Clean up the spawned server and pending timers on this early exit.
        debugLog('lsp', `failed to read ${opts.filePath}`, err)
        complete(null, false)
        return
      }
    }

    const ctx: LspSessionContext<T> = {
      send,
      finish: (result: T) => complete(result, true),
      scheduleIdleFinish: () => {
        if (opts.idleFinishMs === undefined || opts.idleResult === undefined) return
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => complete(opts.idleResult!(), true), opts.idleFinishMs)
      },
      targetText,
    }

    // code-spider-gqd
    const parser = new JsonRpcFrameParser()
    proc.stdout?.on('data', (chunk: Buffer) => {
      for (const parsed of parser.push(chunk)) {
        const msg = parsed as { id?: number; result?: unknown; method?: string; params?: unknown }
        if (!initialized && msg.id === 1 && msg.result !== undefined) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          opts.onInitialized(ctx)
          continue
        }
        opts.onMessage(msg, ctx)
      }
    })

    proc.on('error', (err: Error) => {
      // code-spider-bik
      debugLog('lsp', `server process error: ${opts.filePath}`, err)
      complete(null, false)
    })
    proc.on('close', () => {
      if (completed) return
      completed = true
      clearTimers()
      resolve(opts.onClose !== undefined ? opts.onClose(initialized) : null)
    })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(opts.repoRoot),
        capabilities: opts.capabilities,
        initializationOptions: {},
      },
    })
  })
}

// code-spider-zex
// Shared didOpen for the workspace files reference/definition sessions feed.
function sendWorkspaceDidOpens(
  send: (msg: object) => void,
  workspaceFiles: Array<{ path: string; text: string }>,
  languageId: string,
): void {
  for (const workspaceFile of workspaceFiles) {
    send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
      textDocument: {
        uri: fileUri(workspaceFile.path),
        languageId,
        version: 1,
        text: workspaceFile.text,
      },
    }})
  }
}

// Attempt real LSP communication via stdio JSON-RPC
async function tryRealLspDocumentSymbols(
  filePath: string,
  command: string[],
  languageId: string,
  repoRoot: string,
): Promise<LspSymbol[] | null> {
  // code-spider-zex
  const uri = fileUri(filePath)
  return runLspSession<LspSymbol[]>({
    command,
    filePath,
    repoRoot,
    capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
    onInitialized: ({ send, targetText }) => {
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
        textDocument: { uri, languageId, version: 1, text: targetText }
      }})
      send({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: {
        textDocument: { uri }
      }})
    },
    onMessage: (msg, { finish, targetText }) => {
      if (msg.id === 2) {
        finish(applyInferredSelectionRanges(normalizeDocumentSymbolResult(msg.result), targetText))
      }
    },
  })
}

async function tryRealLspReferences(
  filePath: string,
  command: string[],
  languageId: string,
  position: { line: number; character: number },
  repoRoot: string,
  workspaceFiles: Array<{ path: string; text: string }>,
): Promise<LspLocation[] | null> {
  // code-spider-zex
  const uri = fileUri(filePath)
  return runLspSession<LspLocation[]>({
    command,
    filePath,
    repoRoot,
    capabilities: { textDocument: { references: { dynamicRegistration: false } } },
    onInitialized: ({ send }) => {
      sendWorkspaceDidOpens(send, workspaceFiles, languageId)
      send({ jsonrpc: '2.0', id: 2, method: 'textDocument/references', params: {
        textDocument: { uri },
        position,
        context: { includeDeclaration: true },
      }})
    },
    onMessage: (msg, { finish }) => {
      if (msg.id !== 2) return
      const result = Array.isArray(msg.result) ? msg.result : []
      finish(result.flatMap(item => {
        const raw = item as Record<string, unknown>
        const locationUri = typeof raw['uri'] === 'string' ? raw['uri'] : undefined
        const range = raw['range'] as LspLocation['range'] | undefined
        if (!locationUri || !range) return []
        return [{ uri: locationUri, range }]
      }))
    },
  })
}

async function tryRealLspDefinitions(
  filePath: string,
  command: string[],
  languageId: string,
  position: { line: number; character: number },
  repoRoot: string,
  workspaceFiles: Array<{ path: string; text: string }>,
): Promise<LspLocation[] | null> {
  // code-spider-zex
  const uri = fileUri(filePath)
  return runLspSession<LspLocation[]>({
    command,
    filePath,
    repoRoot,
    capabilities: { textDocument: { definition: { dynamicRegistration: false } } },
    // Target content arrives via workspaceFiles; no direct read needed.
    readTargetFile: false,
    onInitialized: ({ send }) => {
      sendWorkspaceDidOpens(send, workspaceFiles, languageId)
      send({ jsonrpc: '2.0', id: 2, method: 'textDocument/definition', params: {
        textDocument: { uri },
        position,
      }})
    },
    onMessage: (msg, { finish }) => {
      if (msg.id !== 2) return
      const rawResult = Array.isArray(msg.result) ? msg.result : (msg.result ? [msg.result] : [])
      finish(rawResult.flatMap(item => {
        const raw = item as Record<string, unknown>
        const locationUri = typeof raw['uri'] === 'string'
          ? raw['uri']
          : (typeof raw['targetUri'] === 'string' ? raw['targetUri'] : undefined)
        const range = isRange(raw['range'])
          ? raw['range']
          : (isRange(raw['targetSelectionRange']) ? raw['targetSelectionRange'] : undefined)
        if (!locationUri || !range) return []
        return [{ uri: locationUri, range }]
      }))
    },
  })
}

async function tryRealLspDiagnostics(
  filePath: string,
  command: string[],
  languageId: string,
  repoRoot: string,
): Promise<LspDiagnostic[] | null> {
  // code-spider-zex
  // Diagnostics are notification-driven: open the document, then collect
  // publishDiagnostics until the server goes quiet (idle finish) or the
  // overall deadline lands — partial results still count.
  const uri = fileUri(filePath)
  const diagnostics: LspDiagnostic[] = []
  return runLspSession<LspDiagnostic[]>({
    command,
    filePath,
    repoRoot,
    capabilities: { textDocument: { publishDiagnostics: {} } },
    timeoutMs: 4000,
    onTimeout: () => diagnostics,
    idleFinishMs: 350,
    idleResult: () => diagnostics,
    onInitialized: ({ send, targetText, scheduleIdleFinish }) => {
      send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
        textDocument: { uri, languageId, version: 1, text: targetText }
      }})
      scheduleIdleFinish()
    },
    onMessage: (msg, { scheduleIdleFinish }) => {
      if (msg.method !== 'textDocument/publishDiagnostics') return
      const params = msg.params as {
        uri?: string
        diagnostics?: LspDiagnostic[]
      } | undefined
      if (params?.uri === uri && Array.isArray(params.diagnostics)) {
        diagnostics.length = 0
        diagnostics.push(...params.diagnostics)
        scheduleIdleFinish()
      }
    },
    onClose: (initialized) => (initialized ? diagnostics : null),
  })
}

export class LspAdapter {
  async getSymbols(
    filePath: string,
    language: string,
    repoRoot = process.cwd(),
    commandOverride?: string[],
    allowHeuristicFallback = false,
  ): Promise<LspResult> {
    const langLower = language.toLowerCase()
    const selectedCommand = commandOverride

    if (selectedCommand !== undefined) {
      try {
        const realSymbols = await tryRealLspDocumentSymbols(filePath, selectedCommand, langLower, repoRoot)
        if (realSymbols !== null && realSymbols.length > 0) {
          return { filePath, symbols: realSymbols, diagnostics: [] }
        }
      } catch (err) {
        // code-spider-bik
        debugLog('lsp', `request failed, degrading: ${filePath}`, err)
        // fall through
      }
    }

    if (allowHeuristicFallback) {
      return { filePath, symbols: [], diagnostics: [], error: 'heuristic-mode' }
    }

    return { filePath, symbols: [], diagnostics: [], error: 'no-symbols' }
  }

  async getReferences(
    filePath: string,
    language: string,
    position: { line: number; character: number },
    repoRoot = process.cwd(),
    commandOverride?: string[],
    workspaceFilePaths?: string[],
  ): Promise<{ locations: Array<LspLocation & { path: string }>; error?: string }> {
    const langLower = language.toLowerCase()
    const selectedCommand = commandOverride

    if (selectedCommand === undefined) {
      return { locations: [], error: 'no-references-provider' }
    }

    try {
      const workspacePaths = workspaceFilePaths ?? [filePath]
      const workspaceFiles = workspacePaths.flatMap(path => {
        try {
          return [{ path, text: readFileSync(path, 'utf8') }]
        } catch (err) {
          // code-spider-bik
          debugLog('lsp', `failed to read workspace file ${path}`, err)
          return []
        }
      })
      const ensuredTarget = workspaceFiles.some(file => file.path === filePath)
        ? workspaceFiles
        : [{ path: filePath, text: readFileSync(filePath, 'utf8') }, ...workspaceFiles]

      const locations = await tryRealLspReferences(
        filePath,
        selectedCommand,
        langLower,
        position,
        repoRoot,
        ensuredTarget,
      )
      if (locations !== null) {
        return {
          locations: locations.map(location => ({
            ...location,
            path: uriToPath(location.uri),
          })),
        }
      }
    } catch (err) {
      // code-spider-bik
      debugLog('lsp', `request failed, degrading: ${filePath}`, err)
      // fall through
    }

    return { locations: [], error: 'no-references' }
  }

  async getDefinitions(
    filePath: string,
    language: string,
    position: { line: number; character: number },
    repoRoot = process.cwd(),
    commandOverride?: string[],
    workspaceFilePaths?: string[],
  ): Promise<{ locations: Array<LspLocation & { path: string }>; error?: string }> {
    const langLower = language.toLowerCase()
    const selectedCommand = commandOverride

    if (selectedCommand === undefined) {
      return { locations: [], error: 'no-definitions-provider' }
    }

    try {
      const workspacePaths = workspaceFilePaths ?? [filePath]
      const workspaceFiles = workspacePaths.flatMap(path => {
        try {
          return [{ path, text: readFileSync(path, 'utf8') }]
        } catch (err) {
          // code-spider-bik
          debugLog('lsp', `failed to read workspace file ${path}`, err)
          return []
        }
      })
      const ensuredTarget = workspaceFiles.some(file => file.path === filePath)
        ? workspaceFiles
        : [{ path: filePath, text: readFileSync(filePath, 'utf8') }, ...workspaceFiles]
      const locations = await tryRealLspDefinitions(
        filePath,
        selectedCommand,
        langLower,
        position,
        repoRoot,
        ensuredTarget,
      )
      if (locations !== null) {
        return {
          locations: locations.map(location => ({
            ...location,
            path: uriToPath(location.uri),
          })),
        }
      }
    } catch (err) {
      // code-spider-bik
      debugLog('lsp', `request failed, degrading: ${filePath}`, err)
      // fall through
    }

    return { locations: [], error: 'no-definitions' }
  }

  async getDiagnostics(
    filePath: string,
    language: string,
    repoRoot = process.cwd(),
    commandOverride?: string[],
  ): Promise<{ diagnostics: LspDiagnostic[]; error?: string }> {
    const langLower = language.toLowerCase()
    const selectedCommand = commandOverride

    if (selectedCommand === undefined) {
      return { diagnostics: [], error: 'no-diagnostics-provider' }
    }

    try {
      const diagnostics = await tryRealLspDiagnostics(filePath, selectedCommand, langLower, repoRoot)
      if (diagnostics !== null) {
        return { diagnostics }
      }
    } catch (err) {
      // code-spider-bik
      debugLog('lsp', `request failed, degrading: ${filePath}`, err)
      // fall through
    }

    return { diagnostics: [], error: 'no-diagnostics' }
  }
}
