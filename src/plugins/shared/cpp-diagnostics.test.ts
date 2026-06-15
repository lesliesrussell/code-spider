// code-spider-7ab
import { describe, expect, test } from 'bun:test'
import { parseClangTidy, parseCppcheck } from './cpp-diagnostics'

describe('parseClangTidy', () => {
  test('parses a single warning with check name into a 0-based diagnostic', () => {
    const text =
      "/repo/src/foo.c:42:5: warning: Value stored to 'x' is never read [clang-analyzer-deadcode.DeadStores]"
    const diags = parseClangTidy(text)
    expect(diags).toEqual([
      {
        severity: 2,
        message: "Value stored to 'x' is never read",
        code: 'clang-analyzer-deadcode.DeadStores',
        range: {
          start: { line: 41, character: 4 },
          end: { line: 41, character: 4 },
        },
      },
    ])
  })

  test('folds note: lines into the preceding finding instead of emitting them', () => {
    const text = [
      '/repo/src/foo.c:42:5: warning: Use after free [clang-analyzer-cplusplus.NewDelete]',
      '/repo/src/foo.c:40:3: note: Memory is freed here',
    ].join('\n')
    const diags = parseClangTidy(text)
    expect(diags).toHaveLength(1)
    expect(diags[0]?.severity).toBe(2)
    expect(diags[0]?.code).toBe('clang-analyzer-cplusplus.NewDelete')
    expect(diags[0]?.message).toBe('Use after free\nnote: Memory is freed here')
  })

  test('drops leading note: lines with no preceding finding', () => {
    const diags = parseClangTidy('/repo/src/foo.c:1:1: note: orphan note')
    expect(diags).toEqual([])
  })
})

describe('parseCppcheck', () => {
  test('parses an error line (template-formatted) into a 0-based diagnostic', () => {
    const text = '/repo/src/foo.c:10:7: error: Null pointer dereference: p [nullPointer]'
    expect(parseCppcheck(text)).toEqual([
      {
        severity: 1,
        message: 'Null pointer dereference: p',
        code: 'nullPointer',
        range: {
          start: { line: 9, character: 6 },
          end: { line: 9, character: 6 },
        },
      },
    ])
  })

  test('maps cppcheck severities (error/warning/style/performance/portability/information)', () => {
    const text = [
      '/r/a.c:1:1: error: e [idE]',
      '/r/a.c:2:1: warning: w [idW]',
      '/r/a.c:3:1: style: s [idS]',
      '/r/a.c:4:1: performance: p [idP]',
      '/r/a.c:5:1: portability: po [idPo]',
      '/r/a.c:6:1: information: i [idI]',
    ].join('\n')
    expect(parseCppcheck(text).map(d => d.severity)).toEqual([1, 2, 3, 3, 3, 4])
  })

  test('skips unparseable lines', () => {
    const text = ['Checking /repo/src/foo.c ...', 'nofile here', ''].join('\n')
    expect(parseCppcheck(text)).toEqual([])
  })
})
