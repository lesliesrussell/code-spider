// code-spider-due
import { describe, expect, test } from 'bun:test'
import { loadDefaultAnalyzerRegistry } from '../analyzer-registry-loader'
import { BuiltinLanguagePluginRegistry } from '../language-plugin-registry'
import { CppPlugin } from './cpp-plugin'

const registry = loadDefaultAnalyzerRegistry()
const noTools = () => false
const allTools = () => true

function plugin(commandExists: (bin: string) => boolean): CppPlugin {
  // lsp is unused by the skeleton's detect/health/capabilityStatus paths.
  return new CppPlugin(registry, commandExists)
}

describe('CppPlugin', () => {
  test('identity covers both c and cpp', () => {
    const p = plugin(noTools)
    expect(p.id).toBe('builtin.cpp')
    expect(p.languageIds).toEqual(['c', 'cpp'])
  })

  test('detects a .c file as c and a .cpp file as cpp', () => {
    const p = plugin(noTools)
    expect(p.detect('/repo', '/repo/src/foo.c')).toMatchObject({ supported: true, languageId: 'c' })
    expect(p.detect('/repo', '/repo/src/foo.cpp')).toMatchObject({ supported: true, languageId: 'cpp' })
  })

  test('does not claim unrelated files', () => {
    expect(plugin(noTools).detect('/repo', '/repo/src/foo.rs').supported).toBe(false)
  })

  test('health reports clangd available only when the binary exists', () => {
    expect(plugin(allTools).health('/repo')).toMatchObject({ available: true, toolName: 'clangd' })
    expect(plugin(noTools).health('/repo').available).toBe(false)
  })

  test('symbols stay available via the heuristic fallback even with no tools', () => {
    const status = plugin(noTools).capabilityStatus('/repo')
    expect(status.symbols).toEqual({ supported: true, available: true })
    // clang-tidy/cppcheck/clangd all need a binary — no heuristic diagnostics.
    expect(status.diagnostics).toEqual({ supported: true, available: false })
    expect(status.references).toEqual({ supported: true, available: false })
  })

  test('diagnostics + references become available once tools are present', () => {
    const status = plugin(allTools).capabilityStatus('/repo')
    expect(status.diagnostics.available).toBe(true)
    expect(status.references.available).toBe(true)
  })
})

describe('BuiltinLanguagePluginRegistry registration', () => {
  test('routes c and cpp to the CppPlugin', () => {
    const reg = new BuiltinLanguagePluginRegistry(registry, allTools)
    expect(reg.getByLanguage('c')?.id).toBe('builtin.cpp')
    expect(reg.getByLanguage('cpp')?.id).toBe('builtin.cpp')
  })
})
