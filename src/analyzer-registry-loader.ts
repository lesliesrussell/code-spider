import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  ANALYZER_CAPABILITIES,
  ANALYZER_KINDS,
  ANALYZER_REGISTRY_VERSION,
  type AnalyzerCapability,
  type AnalyzerRegistryDocument,
  type AnalyzerKind,
  type RegistryAnalyzer,
  type RegistryLanguage,
} from './analyzer-registry'

interface ParseState {
  index: number
  lines: string[]
}

export class AnalyzerRegistryError extends Error {}

function stripComment(line: string): string {
  const trimmed = line.trimStart()
  if (trimmed.startsWith('#')) return ''
  const idx = line.indexOf(' #')
  return idx === -1 ? line : line.slice(0, idx)
}

function preprocess(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(stripComment)
    .filter(line => line.trim() !== '')
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function currentLine(state: ParseState): string | undefined {
  return state.lines[state.index]
}

function expectLine(state: ParseState, message: string): string {
  const line = currentLine(state)
  if (line === undefined) {
    throw new AnalyzerRegistryError(message)
  }
  return line
}

function parseScalarValue(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function parseStringList(state: ParseState, indent: number): string[] {
  const values: string[] = []

  while (state.index < state.lines.length) {
    const line = currentLine(state)
    if (line === undefined) break
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      throw new AnalyzerRegistryError(`Unexpected indentation in list item: ${line.trim()}`)
    }

    const match = /^\s*-\s*(.+?)\s*$/.exec(line)
    if (!match) break
    values.push(parseScalarValue(match[1] ?? ''))
    state.index++
  }

  return values
}

function parseLanguageList(state: ParseState, indent: number): RegistryLanguage[] {
  const languages: RegistryLanguage[] = []

  while (state.index < state.lines.length) {
    const line = currentLine(state)
    if (line === undefined) break
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      throw new AnalyzerRegistryError(`Unexpected indentation in language definition: ${line.trim()}`)
    }

    if (!line.trimStart().startsWith('- ')) break
    languages.push(parseLanguage(state, indent))
  }

  return languages
}

function parseLanguage(state: ParseState, indent: number): RegistryLanguage {
  const line = expectLine(state, 'Expected language definition')
  const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
  if (!idMatch) {
    throw new AnalyzerRegistryError(`Expected language id entry, got: ${line.trim()}`)
  }

  const language: Partial<RegistryLanguage> = {
    id: parseScalarValue(idMatch[1] ?? ''),
    detect: {},
    analyzers: [],
  }
  state.index++

  while (state.index < state.lines.length) {
    const next = currentLine(state)
    if (next === undefined) break
    const nextIndent = indentOf(next)
    if (nextIndent <= indent) break

    if (nextIndent !== indent + 2) {
      throw new AnalyzerRegistryError(`Unexpected indentation in language block: ${next.trim()}`)
    }

    const trimmed = next.trim()
    if (trimmed === 'display_name:') {
      throw new AnalyzerRegistryError('display_name must be declared inline as a scalar')
    }
    if (trimmed.startsWith('display_name:')) {
      language.display_name = parseScalarValue(trimmed.slice('display_name:'.length))
      state.index++
      continue
    }
    if (trimmed === 'aliases:') {
      state.index++
      language.aliases = parseStringList(state, indent + 4)
      continue
    }
    if (trimmed === 'detect:') {
      state.index++
      language.detect = parseDetectBlock(state, indent + 4)
      continue
    }
    if (trimmed === 'analyzers:') {
      state.index++
      language.analyzers = parseAnalyzerList(state, indent + 4)
      continue
    }

    throw new AnalyzerRegistryError(`Unknown language field: ${trimmed}`)
  }

  return validateLanguage(language)
}

function parseDetectBlock(state: ParseState, indent: number): RegistryLanguage['detect'] {
  const detect: RegistryLanguage['detect'] = {}

  while (state.index < state.lines.length) {
    const line = currentLine(state)
    if (line === undefined) break
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent !== indent) {
      throw new AnalyzerRegistryError(`Unexpected indentation in detect block: ${line.trim()}`)
    }

    const trimmed = line.trim()
    if (trimmed === 'extensions:') {
      state.index++
      detect.extensions = parseStringList(state, indent + 2)
      continue
    }
    if (trimmed === 'manifests:') {
      state.index++
      detect.manifests = parseStringList(state, indent + 2)
      continue
    }

    throw new AnalyzerRegistryError(`Unknown detect field: ${trimmed}`)
  }

  return detect
}

function parseAnalyzerList(state: ParseState, indent: number): RegistryAnalyzer[] {
  const analyzers: RegistryAnalyzer[] = []

  while (state.index < state.lines.length) {
    const line = currentLine(state)
    if (line === undefined) break
    const lineIndent = indentOf(line)
    if (lineIndent < indent) break
    if (lineIndent > indent) {
      throw new AnalyzerRegistryError(`Unexpected indentation in analyzer definition: ${line.trim()}`)
    }

    if (!line.trimStart().startsWith('- ')) break
    analyzers.push(parseAnalyzer(state, indent))
  }

  return analyzers
}

function parseAnalyzer(state: ParseState, indent: number): RegistryAnalyzer {
  const line = expectLine(state, 'Expected analyzer definition')
  const idMatch = /^\s*-\s+id:\s*(.+?)\s*$/.exec(line)
  if (!idMatch) {
    throw new AnalyzerRegistryError(`Expected analyzer id entry, got: ${line.trim()}`)
  }

  const analyzer: Partial<RegistryAnalyzer> = {
    id: parseScalarValue(idMatch[1] ?? ''),
  }
  state.index++

  while (state.index < state.lines.length) {
    const next = currentLine(state)
    if (next === undefined) break
    const nextIndent = indentOf(next)
    if (nextIndent <= indent) break

    if (nextIndent !== indent + 2) {
      throw new AnalyzerRegistryError(`Unexpected indentation in analyzer block: ${next.trim()}`)
    }

    const trimmed = next.trim()
    if (trimmed.startsWith('kind:')) {
      analyzer.kind = parseScalarValue(trimmed.slice('kind:'.length)) as AnalyzerKind
      state.index++
      continue
    }
    if (trimmed.startsWith('tool:')) {
      analyzer.tool = parseScalarValue(trimmed.slice('tool:'.length))
      state.index++
      continue
    }
    if (trimmed === 'command:') {
      state.index++
      analyzer.command = parseStringList(state, indent + 4)
      continue
    }
    if (trimmed === 'capabilities:') {
      state.index++
      analyzer.capabilities = parseStringList(state, indent + 4) as AnalyzerCapability[]
      continue
    }
    if (trimmed.startsWith('priority:')) {
      analyzer.priority = Number.parseInt(parseScalarValue(trimmed.slice('priority:'.length)), 10)
      state.index++
      continue
    }
    if (trimmed === 'required_files:') {
      state.index++
      analyzer.required_files = parseStringList(state, indent + 4)
      continue
    }
    if (trimmed.startsWith('notes:')) {
      analyzer.notes = parseScalarValue(trimmed.slice('notes:'.length))
      state.index++
      continue
    }

    throw new AnalyzerRegistryError(`Unknown analyzer field: ${trimmed}`)
  }

  return validateAnalyzer(analyzer)
}

function validateLanguage(language: Partial<RegistryLanguage>): RegistryLanguage {
  if (!language.id || !/^[a-z][a-z0-9-]*$/.test(language.id)) {
    throw new AnalyzerRegistryError(`Invalid language id: ${language.id ?? '(missing)'}`)
  }
  if (!language.display_name) {
    throw new AnalyzerRegistryError(`Missing display_name for language ${language.id}`)
  }
  if (!language.detect) {
    throw new AnalyzerRegistryError(`Missing detect block for language ${language.id}`)
  }
  const hasExtensions = Array.isArray(language.detect.extensions) && language.detect.extensions.length > 0
  const hasManifests = Array.isArray(language.detect.manifests) && language.detect.manifests.length > 0
  if (!hasExtensions && !hasManifests) {
    throw new AnalyzerRegistryError(`Language ${language.id} must define at least one detection signal`)
  }
  for (const ext of language.detect.extensions ?? []) {
    if (!ext.startsWith('.')) {
      throw new AnalyzerRegistryError(`Language ${language.id} has invalid extension ${ext}`)
    }
  }
  if (!Array.isArray(language.analyzers) || language.analyzers.length === 0) {
    throw new AnalyzerRegistryError(`Language ${language.id} must define at least one analyzer`)
  }

  const seenAnalyzerIds = new Set<string>()
  for (const analyzer of language.analyzers) {
    if (seenAnalyzerIds.has(analyzer.id)) {
      throw new AnalyzerRegistryError(`Language ${language.id} has duplicate analyzer id ${analyzer.id}`)
    }
    seenAnalyzerIds.add(analyzer.id)
  }

  return {
    id: language.id,
    display_name: language.display_name,
    aliases: language.aliases ?? [],
    detect: language.detect,
    analyzers: language.analyzers,
  }
}

function validateAnalyzer(analyzer: Partial<RegistryAnalyzer>): RegistryAnalyzer {
  if (!analyzer.id) {
    throw new AnalyzerRegistryError('Analyzer id is required')
  }
  if (!analyzer.kind || !ANALYZER_KINDS.includes(analyzer.kind)) {
    throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} has invalid kind ${String(analyzer.kind)}`)
  }
  if (!analyzer.tool) {
    throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} is missing tool`)
  }
  if (!Array.isArray(analyzer.command) || analyzer.command.length === 0) {
    throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} must define a non-empty command`)
  }
  if (!Array.isArray(analyzer.capabilities) || analyzer.capabilities.length === 0) {
    throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} must define at least one capability`)
  }
  for (const capability of analyzer.capabilities) {
    if (!ANALYZER_CAPABILITIES.includes(capability)) {
      throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} has invalid capability ${capability}`)
    }
  }
  if (!Number.isInteger(analyzer.priority)) {
    throw new AnalyzerRegistryError(`Analyzer ${analyzer.id} must define an integer priority`)
  }
  const priority = analyzer.priority as number

  return {
    id: analyzer.id,
    kind: analyzer.kind,
    tool: analyzer.tool,
    command: analyzer.command,
    capabilities: analyzer.capabilities,
    priority,
    required_files: analyzer.required_files ?? [],
    notes: analyzer.notes,
  }
}

export function parseAnalyzerRegistry(text: string): AnalyzerRegistryDocument {
  const lines = preprocess(text)
  const state: ParseState = { index: 0, lines }
  const doc: Partial<AnalyzerRegistryDocument> = {}

  while (state.index < state.lines.length) {
    const line = expectLine(state, 'Unexpected end of analyzer registry')
    const trimmed = line.trim()

    if (trimmed.startsWith('version:')) {
      doc.version = Number.parseInt(parseScalarValue(trimmed.slice('version:'.length)), 10)
      state.index++
      continue
    }

    if (trimmed === 'capabilities:') {
      state.index++
      doc.capabilities = parseStringList(state, 2) as AnalyzerCapability[]
      continue
    }

    if (trimmed === 'languages:') {
      state.index++
      doc.languages = parseLanguageList(state, 2)
      continue
    }

    throw new AnalyzerRegistryError(`Unknown top-level field: ${trimmed}`)
  }

  return validateRegistryDocument(doc)
}

function validateRegistryDocument(doc: Partial<AnalyzerRegistryDocument>): AnalyzerRegistryDocument {
  if (doc.version !== ANALYZER_REGISTRY_VERSION) {
    throw new AnalyzerRegistryError(
      `Analyzer registry version must be ${ANALYZER_REGISTRY_VERSION}, got ${String(doc.version)}`
    )
  }

  if (doc.capabilities !== undefined) {
    for (const capability of doc.capabilities) {
      if (!ANALYZER_CAPABILITIES.includes(capability)) {
        throw new AnalyzerRegistryError(`Unknown registry capability ${capability}`)
      }
    }
  }

  if (!Array.isArray(doc.languages) || doc.languages.length === 0) {
    throw new AnalyzerRegistryError('Analyzer registry must define at least one language')
  }

  const seenLanguageIds = new Set<string>()
  for (const language of doc.languages) {
    if (seenLanguageIds.has(language.id)) {
      throw new AnalyzerRegistryError(`Duplicate language id ${language.id}`)
    }
    seenLanguageIds.add(language.id)
  }

  return {
    version: ANALYZER_REGISTRY_VERSION,
    capabilities: doc.capabilities ?? [...ANALYZER_CAPABILITIES],
    languages: doc.languages,
  }
}

export function loadAnalyzerRegistryFromPath(path: string): AnalyzerRegistryDocument {
  if (!existsSync(path)) {
    throw new AnalyzerRegistryError(`Analyzer registry not found: ${path}`)
  }

  try {
    const text = readFileSync(path, 'utf8')
    return parseAnalyzerRegistry(text)
  } catch (err) {
    if (err instanceof AnalyzerRegistryError) {
      throw err
    }
    const message = err instanceof Error ? err.message : String(err)
    throw new AnalyzerRegistryError(`Failed to read analyzer registry: ${message}`)
  }
}

export function loadDefaultAnalyzerRegistry(): AnalyzerRegistryDocument {
  const defaultPath = resolve(import.meta.dir, '..', 'config', 'analyzers.yaml')
  return loadAnalyzerRegistryFromPath(defaultPath)
}

// code-spider-d12
export interface AnalyzerRegistryLoadResult {
  registry: AnalyzerRegistryDocument
  // Parse/read error when the fallback registry was substituted.
  error?: string
}

// code-spider-d12
// Fail-soft entry point: a user-edited analyzers.yaml with a syntax slip must
// not crash doctor and every semantic command. The strict parser still throws
// (validation stays sharp); this wrapper substitutes an empty registry —
// structural-only mode keeps working — and reports the error so doctor can
// surface it.
export function loadAnalyzerRegistrySafeFromPath(path: string): AnalyzerRegistryLoadResult {
  try {
    return { registry: loadAnalyzerRegistryFromPath(path) }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      registry: {
        version: ANALYZER_REGISTRY_VERSION,
        capabilities: [...ANALYZER_CAPABILITIES],
        languages: [],
      },
      error: message,
    }
  }
}

// code-spider-d12
export function loadDefaultAnalyzerRegistrySafe(): AnalyzerRegistryLoadResult {
  return loadAnalyzerRegistrySafeFromPath(resolve(import.meta.dir, '..', 'config', 'analyzers.yaml'))
}

// code-spider-ofm
// Extension → display-name map derived from the registry, so a language added
// only in config/analyzers.yaml is recognized during the filesystem walk
// (otherwise its files index as 'Other' and semantic enrichment never sees
// them). Merged over the built-in extension map by the indexer.
export function registryExtensionLanguages(registry: AnalyzerRegistryDocument): Record<string, string> {
  const map: Record<string, string> = {}
  for (const language of registry.languages) {
    for (const ext of language.detect.extensions ?? []) {
      map[ext] = language.display_name
    }
  }
  return map
}
