// code-spider-bik
import { describe, expect, test, beforeEach, afterEach, spyOn, type Mock } from 'bun:test'
import { debugLog } from './debug'

let errorSpy: Mock<typeof console.error>
const originalEnv = process.env['CODE_SPIDER_DEBUG']

beforeEach(() => {
  errorSpy = spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errorSpy.mockRestore()
  if (originalEnv === undefined) {
    delete process.env['CODE_SPIDER_DEBUG']
  } else {
    process.env['CODE_SPIDER_DEBUG'] = originalEnv
  }
})

describe('debugLog', () => {
  test('silent by default', () => {
    delete process.env['CODE_SPIDER_DEBUG']
    debugLog('scope', 'something failed', new Error('boom'))
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test('writes to stderr when CODE_SPIDER_DEBUG=1', () => {
    process.env['CODE_SPIDER_DEBUG'] = '1'
    debugLog('lsp', 'spawn failed', new Error('ENOENT'))
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[code-spider:lsp] spawn failed: ENOENT')
  })

  test('formats non-Error detail and omits empty detail', () => {
    process.env['CODE_SPIDER_DEBUG'] = 'true'
    debugLog('git', 'query failed', 'exit 128')
    debugLog('git', 'no detail')
    expect(errorSpy.mock.calls[0]?.[0]).toBe('[code-spider:git] query failed: exit 128')
    expect(errorSpy.mock.calls[1]?.[0]).toBe('[code-spider:git] no detail')
  })
})
