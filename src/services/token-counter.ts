// code-spider-ab9
// Token counts here are deliberate estimates — a confidence booster, not an
// audit. A ratio is enough; the interface lets a real BPE tokenizer drop in
// later without touching the accounting code.
export type TokenKind = 'code' | 'prose' | 'diff'

const RATIOS: Record<TokenKind, number> = {
  code: 3.5,
  prose: 4,
  diff: 4,
}

export interface TokenCounter {
  count(text: string, kind?: TokenKind): number
}

export class RatioTokenCounter implements TokenCounter {
  count(text: string, kind: TokenKind = 'code'): number {
    if (text.length === 0) return 0
    return Math.round(text.length / RATIOS[kind])
  }
}

export function tokensFromBytes(bytes: number, kind: TokenKind = 'code'): number {
  if (bytes <= 0) return 0
  return Math.round(bytes / RATIOS[kind])
}
