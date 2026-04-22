import { describe, expect, test } from 'bun:test'
import { AnalyzerRegistryError, loadDefaultAnalyzerRegistry, parseAnalyzerRegistry } from './analyzer-registry-loader'

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
    ])
    expect(
      registry.languages.find(language => language.id === 'zig')?.analyzers.map(analyzer => analyzer.id)
    ).toEqual(['zls', 'zig-ast-check'])
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
