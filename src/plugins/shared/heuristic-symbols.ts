import { classifySymbolSignal, type LspSymbol } from '../../adapters/lsp'

export function heuristicSymbols(source: string): LspSymbol[] {
  const symbols: LspSymbol[] = []
  const zeroRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } }

  const patterns: Array<{ re: RegExp; kind: number; kindName: string }> = [
    { re: /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm, kind: 5, kindName: 'Class' },
    { re: /^(?:export\s+)?interface\s+(\w+)/gm, kind: 11, kindName: 'Interface' },
    { re: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, kind: 12, kindName: 'Function' },
    { re: /^(?:export\s+)?type\s+(\w+)\s*=/gm, kind: 26, kindName: 'TypeParameter' },
    { re: /^(?:export\s+)?(?:const|let)\s+(\w+)/gm, kind: 13, kindName: 'Variable' },
  ]

  const seen = new Set<string>()

  for (const { re, kind, kindName } of patterns) {
    let match: RegExpExecArray | null
    re.lastIndex = 0
    while ((match = re.exec(source)) !== null) {
      const name = match[1]
      if (name === undefined) continue
      const key = `${kindName}:${name}`
      if (seen.has(key)) continue
      seen.add(key)
      symbols.push({
        name,
        kind,
        kindName,
        range: zeroRange,
        selectionRange: zeroRange,
        signal: classifySymbolSignal(name, kindName),
      })
    }
  }

  const methodRe = /^\s{2,}(?:async\s+)?(?:(?:public|private|protected|static|override)\s+)*(\w+)\s*\(/gm
  let match: RegExpExecArray | null
  methodRe.lastIndex = 0
  const blacklist = new Set(['if', 'for', 'while', 'switch', 'catch', 'constructor', 'return'])
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
      range: zeroRange,
      selectionRange: zeroRange,
      signal: classifySymbolSignal(name, 'Method'),
    })
  }

  return symbols
}

