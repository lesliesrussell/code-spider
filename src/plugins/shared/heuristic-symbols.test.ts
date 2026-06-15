// code-spider-z3j
import { describe, expect, test } from 'bun:test'
import { heuristicSymbols } from './heuristic-symbols'

const C_SOURCE = `#define MAX 10
typedef struct Point PointT;
struct Point { int x; int y; };
enum Color { RED, GREEN };
union Data { int i; float f; };
const int globalThing = 5;
int add(int a, int b) {
    return a + b;
}
static void helper(void)
{
    add(1, 2);
}
`

describe('heuristicSymbols (C/C++)', () => {
  test('extracts C structs, enums, functions, defines, and typedefs', () => {
    const names = heuristicSymbols(C_SOURCE, 'c').map(s => s.name)
    expect(names).toContain('MAX')
    expect(names).toContain('Point')
    expect(names).toContain('Color')
    expect(names).toContain('Data')
    expect(names).toContain('PointT')
    expect(names).toContain('add')
    expect(names).toContain('helper') // brace on the next line
  })

  test('does not misread the type of a const declaration as a symbol', () => {
    const names = heuristicSymbols(C_SOURCE, 'c').map(s => s.name)
    expect(names).not.toContain('int')
  })

  test('does not capture control-flow keywords as functions', () => {
    const names = heuristicSymbols(C_SOURCE, 'c').map(s => s.name)
    for (const kw of ['if', 'for', 'while', 'return', 'switch']) {
      expect(names).not.toContain(kw)
    }
  })

  test('classifies add as a Function', () => {
    const add = heuristicSymbols(C_SOURCE, 'c').find(s => s.name === 'add')
    expect(add?.kindName).toBe('Function')
  })

  test('extracts C++ classes under the cpp language', () => {
    const names = heuristicSymbols('class Widget {\n  void draw();\n};\n', 'cpp').map(s => s.name)
    expect(names).toContain('Widget')
  })
})

describe('heuristicSymbols (generic, backward compatible)', () => {
  test('still extracts TypeScript class and function with no language argument', () => {
    const src = 'export class Foo {}\nexport function bar() {}\n'
    const names = heuristicSymbols(src).map(s => s.name)
    expect(names).toContain('Foo')
    expect(names).toContain('bar')
  })

  test('does not apply C patterns to TypeScript', () => {
    // `#define` / `struct` never appear in TS; a const should not yield `int`.
    const names = heuristicSymbols('const x = 5\n', 'typescript').map(s => s.name)
    expect(names).toContain('x')
    expect(names).not.toContain('int')
  })
})
