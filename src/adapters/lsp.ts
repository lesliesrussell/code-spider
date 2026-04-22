import { execSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import type { RegistryAnalyzer, RegistryLanguage } from '../analyzer-registry'

export interface LspSymbol {
  name: string
  kind: number
  kindName: string
  containerName?: string
  range: { start: { line: number; character: number }; end: { line: number; character: number } }
  selectionRange?: { start: { line: number; character: number }; end: { line: number; character: number } }
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

export interface DetectedLsp {
  language: string
  toolName: string
  command: string[]
  available: boolean
}

interface ResolvedLspCandidate {
  language: RegistryLanguage
  analyzer: RegistryAnalyzer
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

function isAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore', timeout: 2000 })
    return true
  } catch {
    return false
  }
}

function fileUri(filePath: string): string {
  return `file://${filePath}`
}

function uriToPath(uri: string): string {
  return uri.startsWith('file://') ? uri.slice('file://'.length) : uri
}

function collectWorkspaceFiles(repoRoot: string, extensions: string[], ignoreDirs = new Set(['.git', '.code-spider', 'node_modules'])): string[] {
  const results: string[] = []

  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ignoreDirs.has(entry.name)) continue
      const fullPath = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        visit(fullPath)
        continue
      }
      if (extensions.some(ext => entry.name.endsWith(ext))) {
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
    const range = extractSymbolRange(raw)
    symbols.push({
      name,
      kind,
      kindName: LSP_SYMBOL_KIND_NAMES[kind] ?? 'Variable',
      containerName: typeof raw['containerName'] === 'string' ? raw['containerName'] : containerName,
      range,
      selectionRange: extractSelectionRange(raw),
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

// Attempt real LSP communication via stdio JSON-RPC
async function tryRealLspDocumentSymbols(
  filePath: string,
  command: string[],
  languageId: string,
  repoRoot: string,
): Promise<LspSymbol[] | null> {
  return new Promise((resolve) => {
    const [bin, ...args] = command
    if (bin === undefined) { resolve(null); return }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      resolve(null)
    }, 10000)

    let buf = ''
    const symbols: LspSymbol[] = []
    let initialized = false
    let docSymbolsRequested = false

    const send = (msg: object): void => {
      const body = JSON.stringify(msg)
      proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }

    const uri = fileUri(filePath)
    let text = ''
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      resolve(null)
      return
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      while (true) {
        const headerEnd = buf.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        const header = buf.slice(0, headerEnd)
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(header)
        if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue }
        const len = parseInt(lenMatch[1]!, 10)
        const bodyStart = headerEnd + 4
        if (buf.length < bodyStart + len) break
        const body = buf.slice(bodyStart, bodyStart + len)
        buf = buf.slice(bodyStart + len)

        let msg: { id?: number; result?: unknown; method?: string }
        try { msg = JSON.parse(body) } catch { continue }

        if (!initialized && msg.id === 1 && msg.result !== undefined) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
            textDocument: { uri, languageId, version: 1, text }
          }})
          docSymbolsRequested = true
          send({ jsonrpc: '2.0', id: 2, method: 'textDocument/documentSymbol', params: {
            textDocument: { uri }
          }})
        } else if (docSymbolsRequested && msg.id === 2) {
          symbols.push(...applyInferredSelectionRanges(normalizeDocumentSymbolResult(msg.result), text))
          send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null })
          send({ jsonrpc: '2.0', method: 'exit', params: null })
          clearTimeout(timer)
          try { proc.kill() } catch { /* ignore */ }
          resolve(symbols)
        }
      }
    })

    proc.on('error', () => { clearTimeout(timer); resolve(null) })
    proc.on('close', () => { clearTimeout(timer); resolve(symbols.length > 0 ? symbols : null) })

    // Send initialize
    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(repoRoot),
        capabilities: { textDocument: { documentSymbol: { hierarchicalDocumentSymbolSupport: true } } },
        initializationOptions: {},
      }
    })
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
  return new Promise((resolve) => {
    const [bin, ...args] = command
    if (bin === undefined) { resolve(null); return }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }

    const timer = setTimeout(() => {
      try { proc.kill() } catch { /* ignore */ }
      resolve(null)
    }, 10000)

    let buf = ''
    let initialized = false
    let referenceRequested = false

    const send = (msg: object): void => {
      const body = JSON.stringify(msg)
      proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }

    const uri = fileUri(filePath)
    let text = ''
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      resolve(null)
      return
    }

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      while (true) {
        const headerEnd = buf.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        const header = buf.slice(0, headerEnd)
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(header)
        if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue }
        const len = parseInt(lenMatch[1]!, 10)
        const bodyStart = headerEnd + 4
        if (buf.length < bodyStart + len) break
        const body = buf.slice(bodyStart, bodyStart + len)
        buf = buf.slice(bodyStart + len)

        let msg: { id?: number; result?: unknown }
        try { msg = JSON.parse(body) } catch { continue }

        if (!initialized && msg.id === 1 && msg.result !== undefined) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
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
          referenceRequested = true
          send({ jsonrpc: '2.0', id: 2, method: 'textDocument/references', params: {
            textDocument: { uri },
            position,
            context: { includeDeclaration: true },
          }})
        } else if (referenceRequested && msg.id === 2) {
          const result = Array.isArray(msg.result) ? msg.result : []
          const locations: LspLocation[] = result.flatMap(item => {
            const raw = item as Record<string, unknown>
            const locationUri = typeof raw['uri'] === 'string' ? raw['uri'] : undefined
            const range = raw['range'] as LspLocation['range'] | undefined
            if (!locationUri || !range) return []
            return [{ uri: locationUri, range }]
          })
          send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null })
          send({ jsonrpc: '2.0', method: 'exit', params: null })
          clearTimeout(timer)
          try { proc.kill() } catch { /* ignore */ }
          resolve(locations)
        }
      }
    })

    proc.on('error', () => { clearTimeout(timer); resolve(null) })
    proc.on('close', () => { clearTimeout(timer); resolve(null) })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(repoRoot),
        capabilities: { textDocument: { references: { dynamicRegistration: false } } },
        initializationOptions: {},
      }
    })
  })
}

async function tryRealLspDiagnostics(
  filePath: string,
  command: string[],
  languageId: string,
  repoRoot: string,
): Promise<LspDiagnostic[] | null> {
  return new Promise((resolve) => {
    const [bin, ...args] = command
    if (bin === undefined) { resolve(null); return }

    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      resolve(null)
      return
    }

    const diagnostics: LspDiagnostic[] = []
    let initialized = false
    let shutdownStarted = false
    let buf = ''
    let idleTimer: ReturnType<typeof setTimeout> | undefined

    const finish = (): void => {
      if (shutdownStarted) return
      shutdownStarted = true
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      send({ jsonrpc: '2.0', id: 3, method: 'shutdown', params: null })
      send({ jsonrpc: '2.0', method: 'exit', params: null })
      try { proc.kill() } catch { /* ignore */ }
      resolve(diagnostics)
    }

    const send = (msg: object): void => {
      const body = JSON.stringify(msg)
      proc.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
    }

    const uri = fileUri(filePath)
    let text = ''
    try {
      text = readFileSync(filePath, 'utf8')
    } catch {
      resolve(null)
      return
    }

    const scheduleFinish = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(finish, 350)
    }

    const overallTimer = setTimeout(finish, 4000)

    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString()
      while (true) {
        const headerEnd = buf.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        const header = buf.slice(0, headerEnd)
        const lenMatch = /Content-Length:\s*(\d+)/i.exec(header)
        if (!lenMatch) { buf = buf.slice(headerEnd + 4); continue }
        const len = parseInt(lenMatch[1]!, 10)
        const bodyStart = headerEnd + 4
        if (buf.length < bodyStart + len) break
        const body = buf.slice(bodyStart, bodyStart + len)
        buf = buf.slice(bodyStart + len)

        let msg: { id?: number; result?: unknown; method?: string; params?: unknown }
        try { msg = JSON.parse(body) } catch { continue }

        if (!initialized && msg.id === 1 && msg.result !== undefined) {
          initialized = true
          send({ jsonrpc: '2.0', method: 'initialized', params: {} })
          send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: {
            textDocument: { uri, languageId, version: 1, text }
          }})
          scheduleFinish()
          continue
        }

        if (msg.method === 'textDocument/publishDiagnostics') {
          const params = msg.params as {
            uri?: string
            diagnostics?: LspDiagnostic[]
          } | undefined
          if (params?.uri === uri && Array.isArray(params.diagnostics)) {
            diagnostics.length = 0
            diagnostics.push(...params.diagnostics)
            scheduleFinish()
          }
        }
      }
    })

    proc.on('error', () => {
      clearTimeout(overallTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      resolve(null)
    })
    proc.on('close', () => {
      clearTimeout(overallTimer)
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      resolve(initialized ? diagnostics : null)
    })

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: {
        processId: process.pid,
        rootUri: fileUri(repoRoot),
        capabilities: { textDocument: { publishDiagnostics: {} } },
        initializationOptions: {},
      }
    })
  })
}

export class LspAdapter {
  private readonly registry = loadDefaultAnalyzerRegistry()

  private findLanguageDefinition(language: string): RegistryLanguage | undefined {
    const normalized = language.toLowerCase()
    return this.registry.languages.find(entry =>
      entry.id === normalized ||
      entry.display_name.toLowerCase() === normalized ||
      (entry.aliases ?? []).some(alias => alias.toLowerCase() === normalized)
    )
  }

  private isAnalyzerEligible(analyzer: RegistryAnalyzer, repoRoot: string): boolean {
    if ((analyzer.required_files ?? []).length === 0) return true
    return analyzer.required_files?.every(file => existsSync(`${repoRoot}/${file}`)) ?? true
  }

  private getLspCandidates(repoRoot: string, language?: string): ResolvedLspCandidate[] {
    const languageEntry = language ? this.findLanguageDefinition(language) : undefined
    const languages = languageEntry ? [languageEntry] : language ? [] : this.registry.languages

    const candidates: ResolvedLspCandidate[] = []
    for (const entry of languages) {
      for (const analyzer of entry.analyzers) {
        if (analyzer.kind !== 'lsp') continue
        if (!this.isAnalyzerEligible(analyzer, repoRoot)) continue
        candidates.push({ language: entry, analyzer })
      }
    }

    return candidates.sort((a, b) => b.analyzer.priority - a.analyzer.priority)
  }

  getSupportedLanguages(): string[] {
    return this.registry.languages.flatMap(entry => [
      entry.id,
      entry.display_name,
      ...(entry.aliases ?? []),
    ])
  }

  async detectAvailable(repoRoot: string): Promise<DetectedLsp[]> {
    const seen = new Set<string>()
    const results: DetectedLsp[] = []

    for (const candidate of this.getLspCandidates(repoRoot)) {
      const bin = candidate.analyzer.command[0]
      if (bin === undefined) continue
      const key = `${candidate.language.id}:${candidate.analyzer.tool}`
      if (seen.has(key)) continue
      seen.add(key)
      const available = isAvailable(bin)
      results.push({
        language: candidate.language.id,
        toolName: candidate.analyzer.tool,
        command: candidate.analyzer.command,
        available,
      })
    }

    return results
  }

  async getSymbols(
    filePath: string,
    language: string,
    repoRoot = process.cwd(),
    commandOverride?: string[],
    allowHeuristicFallback = false,
  ): Promise<LspResult> {
    const languageDef = this.findLanguageDefinition(language)
    const langLower = languageDef?.id ?? language.toLowerCase()

    // Find a matching available LSP server
    const selectedCommand = commandOverride ?? this.getLspCandidates(repoRoot, langLower).find(
      candidate => isAvailable(candidate.analyzer.command[0] ?? '')
    )?.analyzer.command

    if (selectedCommand !== undefined) {
      try {
        const realSymbols = await tryRealLspDocumentSymbols(filePath, selectedCommand, langLower, repoRoot)
        if (realSymbols !== null && realSymbols.length > 0) {
          return { filePath, symbols: realSymbols, diagnostics: [] }
        }
      } catch {
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
  ): Promise<{ locations: Array<LspLocation & { path: string }>; error?: string }> {
    const languageDef = this.findLanguageDefinition(language)
    const langLower = languageDef?.id ?? language.toLowerCase()
    const selectedCommand = commandOverride ?? this.getLspCandidates(repoRoot, langLower).find(
      candidate => isAvailable(candidate.analyzer.command[0] ?? '')
    )?.analyzer.command

    if (selectedCommand === undefined) {
      return { locations: [], error: 'no-references-provider' }
    }

    try {
      const extensions = languageDef?.detect.extensions ?? []
      const workspacePaths = extensions.length > 0
        ? collectWorkspaceFiles(repoRoot, extensions)
        : [filePath]
      const workspaceFiles = workspacePaths.flatMap(path => {
        try {
          return [{ path, text: readFileSync(path, 'utf8') }]
        } catch {
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
    } catch {
      // fall through
    }

    return { locations: [], error: 'no-references' }
  }

  async getDiagnostics(
    filePath: string,
    language: string,
    repoRoot = process.cwd(),
    commandOverride?: string[],
  ): Promise<{ diagnostics: LspDiagnostic[]; error?: string }> {
    const languageDef = this.findLanguageDefinition(language)
    const langLower = languageDef?.id ?? language.toLowerCase()
    const selectedCommand = commandOverride ?? this.getLspCandidates(repoRoot, langLower).find(
      candidate => isAvailable(candidate.analyzer.command[0] ?? '')
    )?.analyzer.command

    if (selectedCommand === undefined) {
      return { diagnostics: [], error: 'no-diagnostics-provider' }
    }

    try {
      const diagnostics = await tryRealLspDiagnostics(filePath, selectedCommand, langLower, repoRoot)
      if (diagnostics !== null) {
        return { diagnostics }
      }
    } catch {
      // fall through
    }

    return { diagnostics: [], error: 'no-diagnostics' }
  }
}
