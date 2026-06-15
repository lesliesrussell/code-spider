import { classifySymbolSignal, type LspSymbol } from '../../adapters/lsp'

const ZERO_RANGE = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

interface NamePattern {
  re: RegExp
  kind: number
  kindName: string
  group?: number
}

// Shared driver: run each pattern over the source, dedup by kindName:name.
function extract(source: string, patterns: NamePattern[], blacklist?: Set<string>): LspSymbol[] {
  const symbols: LspSymbol[] = []
  const seen = new Set<string>()
  for (const { re, kind, kindName, group } of patterns) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) {
      const name = match[group ?? 1]
      if (name === undefined) continue
      if (blacklist?.has(name)) continue
      const key = `${kindName}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      symbols.push({
        name,
        kind,
        kindName,
        range: ZERO_RANGE,
        selectionRange: ZERO_RANGE,
        signal: classifySymbolSignal(name, kindName),
      })
    }
  }
  return symbols
}

// code-spider-z3j
// language selects the pattern set: C/C++ has a different surface syntax than
// the TS/JS-shaped generic extractor (e.g. `const int x` must not yield `int`,
// and `int foo(...) {` is a function). Defaults to the generic set so existing
// callers are unaffected.
export function heuristicSymbols(source: string, language?: string): LspSymbol[] {
  if (language === 'c' || language === 'cpp') return cppSymbols(source)
  return genericSymbols(source)
}

// code-spider-z3j
const CPP_FUNCTION_BLACKLIST = new Set([
  'if', 'for', 'while', 'switch', 'return', 'sizeof', 'else', 'do', 'goto',
])

function cppSymbols(source: string): LspSymbol[] {
  // LSP SymbolKind: Class=5, Enum=10, Function=12, Constant=14, Struct=23,
  // TypeParameter=26.
  const patterns: NamePattern[] = [
    { re: /^\s*#\s*define\s+(\w+)/gm, kind: 14, kindName: 'Constant' },
    { re: /^\s*typedef\b.*?\b(\w+)\s*;/gm, kind: 26, kindName: 'Typedef' },
    { re: /^\s*struct\s+(\w+)/gm, kind: 23, kindName: 'Struct' },
    { re: /^\s*union\s+(\w+)/gm, kind: 23, kindName: 'Union' },
    { re: /^\s*enum\s+(\w+)/gm, kind: 10, kindName: 'Enum' },
    { re: /^\s*class\s+(\w+)/gm, kind: 5, kindName: 'Class' },
    // Function definitions: a type prefix, the name, a parameter list, then an
    // opening brace (possibly on the next line). Anchored at column 0 so
    // indented calls/statements are not mistaken for definitions.
    { re: /^([A-Za-z_][\w\s*]*?)\s+\*?(\w+)\s*\([^;{]*\)\s*\{/gm, kind: 12, kindName: 'Function', group: 2 },
  ]
  return extract(source, patterns, CPP_FUNCTION_BLACKLIST)
}

function genericSymbols(source: string): LspSymbol[] {
  const patterns: NamePattern[] = [
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 5, kindName: 'Class' },
    { re: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 11, kindName: 'Interface' },
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 12, kindName: 'Function' },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/gm, kind: 26, kindName: 'TypeParameter' },
    { re: /^(?:export\s+)?(?:const|let)\s+(\w+)/gm, kind: 13, kindName: 'Variable' },
  ]
  const symbols = extract(source, patterns)
  const seen = new Set(symbols.map(s => `${s.kindName}:${s.name}`))

  const methodRe = /^\s{2,}(?:async\s+)?(?:(?:public|private|protected|static|override)\s+)*(\w+)\s*\(/gm
  const blacklist = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'])
  let match: RegExpExecArray | null
  methodRe.lastIndex = 0
  while ((match = methodRe.exec(source)) !== null) {
    const name = match[1]
    if (name === undefined || blacklist.has(name)) continue
    const key = `Method:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    symbols.push({
      name,
      kind: 6,
      kindName: 'Method',
      range: ZERO_RANGE,
      selectionRange: ZERO_RANGE,
      signal: classifySymbolSignal(name, 'Method'),
    })
  }

  return symbols
}
