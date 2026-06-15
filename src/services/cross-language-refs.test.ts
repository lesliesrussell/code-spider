// code-spider-ni6
import { describe, expect, test } from 'bun:test'
import { resolveCrossLanguageReferences } from './cross-language-refs'
import type { CrossLangSymbolInput } from './cross-language-refs'

function zig(id: number, name: string, declLine: string, externalRefs: number | null = 0): CrossLangSymbolInput {
  return { id, name, language: 'Zig', kindName: 'Function', declLine, externalRefs }
}
function c(id: number, name: string, declLine: string, externalRefs: number | null = null): CrossLangSymbolInput {
  return { id, name, language: 'C/C++', kindName: 'Function', declLine, externalRefs }
}

describe('resolveCrossLanguageReferences', () => {
  test('links a Zig export fn to a same-named C declaration', () => {
    const out = resolveCrossLanguageReferences([
      zig(1, 'xrealloc', 'export fn xrealloc(ptr: ?*anyopaque, size: usize) callconv(.C) *anyopaque {', 0),
      c(2, 'xrealloc', 'void *xrealloc(void *ptr, size_t size);'),
    ])
    // Both sides of the ABI name are marked referenced: the Zig definition AND
    // the C declaration that is its linker counterpart.
    expect(out).toEqual([
      { symbolId: 1, externalRefs: 1, edges: [{ from: 2, to: 1 }] },
      { symbolId: 2, externalRefs: 1, edges: [{ from: 1, to: 2 }] },
    ])
  })

  test('does not link same-language duplicates', () => {
    const out = resolveCrossLanguageReferences([
      c(1, 'helper', 'void helper(void);'),
      c(2, 'helper', 'void helper(void) { }'),
    ])
    expect(out).toEqual([])
  })

  test('does not link a non-exported Zig symbol even with a C twin', () => {
    const out = resolveCrossLanguageReferences([
      zig(1, 'scratch', 'fn scratch() void {', 0),
      c(2, 'scratch', 'void scratch(void);'),
    ])
    expect(out).toEqual([])
  })

  test('leaves a Zig export with no foreign twin unresolved', () => {
    const out = resolveCrossLanguageReferences([
      zig(1, 'onlyZig', 'export fn onlyZig() void {', 0),
      zig(2, 'alsoZig', 'export fn alsoZig() void {', 0),
    ])
    expect(out).toEqual([])
  })

  test('links a Rust #[no_mangle] export to a same-named C declaration', () => {
    const out = resolveCrossLanguageReferences([
      {
        id: 1,
        name: 'rust_entry',
        language: 'Rust',
        kindName: 'Function',
        declLine: 'pub extern "C" fn rust_entry() {',
        precedingLines: ['#[no_mangle]'],
        externalRefs: 0,
      },
      c(2, 'rust_entry', 'void rust_entry(void);'),
    ])
    expect(out).toEqual([
      { symbolId: 1, externalRefs: 1, edges: [{ from: 2, to: 1 }] },
      { symbolId: 2, externalRefs: 1, edges: [{ from: 1, to: 2 }] },
    ])
  })

  test('links a non-static C global consumed from Zig (reverse direction)', () => {
    const out = resolveCrossLanguageReferences([
      { id: 1, name: 'c_func', language: 'C/C++', kindName: 'Function', declLine: 'void c_func(void) {', externalRefs: 0 },
      { id: 2, name: 'c_func', language: 'Zig', kindName: 'Function', declLine: 'extern fn c_func() void;', externalRefs: 0 },
    ])
    // The C definition (export) and the Zig `extern` declaration that imports
    // it are both referenced across the boundary.
    expect(out).toEqual([
      { symbolId: 1, externalRefs: 1, edges: [{ from: 2, to: 1 }] },
      { symbolId: 2, externalRefs: 1, edges: [{ from: 1, to: 2 }] },
    ])
  })

  test('does not treat a static C function as an ABI export', () => {
    const out = resolveCrossLanguageReferences([
      { id: 1, name: 'priv', language: 'C/C++', kindName: 'Function', declLine: 'static void priv(void) {', externalRefs: 0 },
      { id: 2, name: 'priv', language: 'Zig', kindName: 'Function', declLine: 'extern fn priv() void;', externalRefs: 0 },
    ])
    expect(out).toEqual([])
  })
})
