import { describe, expect, test } from 'bun:test'
// code-spider-d12
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AnalyzerRegistryError, loadAnalyzerRegistrySafeFromPath, loadDefaultAnalyzerRegistry, parseAnalyzerRegistry, registryExtensionLanguages } from './analyzer-registry-loader'

// code-spider-d12 code-spider-xof
describe('loadAnalyzerRegistrySafeFromPath', () => {
  test('falls back to the embedded built-in registry on malformed yaml and reports the error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'code-spider-registry-'))
    try {
      const path = join(dir, 'analyzers.yaml')
      writeFileSync(path, 'languages:\n  - id: zig\n    nonsense_field: true\n')
      const result = loadAnalyzerRegistrySafeFromPath(path)
      expect(result.error).toContain('Unknown language field')
      // code-spider-xof: fallback is the embedded default, not an empty registry
      expect(result.registry.languages.length).toBeGreaterThan(0)
      expect(result.registry.languages.some(language => language.id === 'typescript')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('missing file falls back with an error, never throws', () => {
    const result = loadAnalyzerRegistrySafeFromPath('/nonexistent/analyzers.yaml')
    expect(result.error).toContain('not found')
    expect(result.registry.languages.length).toBeGreaterThan(0)
  })

  test('valid file loads with no error', () => {
    const result = loadAnalyzerRegistrySafeFromPath(join(import.meta.dir, '..', 'config', 'analyzers.yaml'))
    expect(result.error).toBeUndefined()
    expect(result.registry.languages.length).toBeGreaterThan(0)
  })
})

// code-spider-ofm
describe('registryExtensionLanguages', () => {
  test('maps every declared extension to the language display name', () => {
    const registry = parseAnalyzerRegistry(`
version: 1
languages:
  - id: lisp
    display_name: Lisp
    detect:
      extensions:
        - .lisp
        - .lsp
    analyzers:
      - id: lisp-lsp
        kind: lsp
        tool: lisp-language-server
        command:
          - lisp-language-server
          - --stdio
        capabilities:
          - symbols
        priority: 100
`)
    expect(registryExtensionLanguages(registry)).toEqual({ '.lisp': 'Lisp', '.lsp': 'Lisp' })
  })

  test('covers the shipped registry languages', () => {
    const registry = loadAnalyzerRegistrySafeFromPath(join(import.meta.dir, '..', 'config', 'analyzers.yaml')).registry
    const map = registryExtensionLanguages(registry)
    expect(map['.ts']).toBe('TypeScript')
    expect(map['.zig']).toBe('Zig')
  })
})

describe('analyzer registry loader', () => {
  test('loads the shipped registry', () => {
    const registry = loadDefaultAnalyzerRegistry()

    expect(registry.version).toBe(1)
    expect(registry.languages.map(language => language.id)).toEqual([
      'typescript',
      'javascript',
      'python',
      'go',
      'rust',
      'zig',
      'c',
      'cpp',
      'shell',
    ])
    expect(
      registry.languages.find(language => language.id === 'zig')?.analyzers.map(analyzer => analyzer.id)
    ).toEqual(['zls', 'zig-ast-check'])
  })

  // code-spider-6q9
  test('exposes c and cpp with the clangd/clang-tidy/cppcheck/heuristic analyzer set', () => {
    const registry = loadDefaultAnalyzerRegistry()
    const c = registry.languages.find(language => language.id === 'c')
    const cpp = registry.languages.find(language => language.id === 'cpp')

    expect(c?.detect.extensions).toContain('.c')
    expect(c?.detect.extensions).toContain('.h')
    expect(c?.analyzers.map(analyzer => analyzer.id)).toEqual([
      'clangd-lsp',
      'clang-tidy',
      'cppcheck',
      'cpp-heuristic',
    ])

    expect(cpp?.detect.extensions).toContain('.cpp')
    expect(cpp?.detect.extensions).toContain('.hpp')
    expect(cpp?.aliases).toContain('c++')
    expect(cpp?.analyzers.map(analyzer => analyzer.id)).toEqual([
      'clangd-lsp',
      'clang-tidy',
      'cppcheck',
      'cpp-heuristic',
    ])
  })

  // code-spider-ua1: clangd owns symbols/defs/refs only — clang-tidy is the
  // primary diagnostics provider, so the base getDiagnostics (first-success-
  // wins by priority) reaches the deep audit instead of stopping at clangd.
  test('clangd does not claim diagnostics for c/cpp; clang-tidy does', () => {
    const registry = loadDefaultAnalyzerRegistry()
    for (const id of ['c', 'cpp']) {
      const language = registry.languages.find(l => l.id === id)
      const clangd = language?.analyzers.find(a => a.id === 'clangd-lsp')
      const clangTidy = language?.analyzers.find(a => a.id === 'clang-tidy')
      expect(clangd?.capabilities).toEqual(['symbols', 'defs', 'refs'])
      expect(clangTidy?.capabilities).toContain('diagnostics')
    }
  })

  test('rejects duplicate language ids', () => {
    const invalid = `
version: 1
languages:
  - id: typescript
    display_name: TypeScript
    detect:
      extensions:
        - .ts
    analyzers:
      - id: tsserver-lsp
        kind: lsp
        tool: typescript-language-server
        command:
          - typescript-language-server
          - --stdio
        capabilities:
          - symbols
        priority: 100
  - id: typescript
    display_name: TypeScript Duplicate
    detect:
      extensions:
        - .tsx
    analyzers:
      - id: tsserver-lsp
        kind: lsp
        tool: typescript-language-server
        command:
          - typescript-language-server
          - --stdio
        capabilities:
          - symbols
        priority: 100
`

    expect(() => parseAnalyzerRegistry(invalid)).toThrow(AnalyzerRegistryError)
    expect(() => parseAnalyzerRegistry(invalid)).toThrow('Duplicate language id typescript')
  })

  test('rejects invalid analyzer capabilities', () => {
    const invalid = `
version: 1
languages:
  - id: zig
    display_name: Zig
    detect:
      extensions:
        - .zig
    analyzers:
      - id: zls
        kind: lsp
        tool: zls
        command:
          - zls
        capabilities:
          - telepathy
        priority: 100
`

    expect(() => parseAnalyzerRegistry(invalid)).toThrow(AnalyzerRegistryError)
    expect(() => parseAnalyzerRegistry(invalid)).toThrow('Analyzer zls has invalid capability telepathy')
  })
})
