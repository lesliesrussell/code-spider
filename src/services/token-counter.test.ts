import { describe, expect, test } from 'bun:test'
import { RatioTokenCounter, tokensFromBytes } from './token-counter'

describe('RatioTokenCounter', () => {
  const tc = new RatioTokenCounter()

  test('counts code text by ~3.5 chars/token', () => {
    expect(tc.count('a'.repeat(350), 'code')).toBe(100)
  })

  test('counts prose by ~4 chars/token', () => {
    expect(tc.count('a'.repeat(400), 'prose')).toBe(100)
  })

  test('defaults to code ratio when kind omitted', () => {
    expect(tc.count('a'.repeat(35))).toBe(10)
  })

  test('empty string is zero tokens', () => {
    expect(tc.count('')).toBe(0)
  })

  test('tokensFromBytes mirrors count for ascii', () => {
    expect(tokensFromBytes(350, 'code')).toBe(100)
  })
})
