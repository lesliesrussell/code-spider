// code-spider-7ui
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { Renderer } from './renderer'
import type { CliContext } from '../types'

function createMockContext(json = false): CliContext {
  return {
    repoRoot: '/tmp/test',
    dbPath: '/tmp/test/.code-spider/index.db',
    json,
    args: [],
    flags: {},
  }
}

describe('Renderer', () => {
  let originalLog: typeof console.log
  let originalError: typeof console.error
  let logs: string[]
  let errors: string[]

  beforeEach(() => {
    logs = []
    errors = []
    originalLog = console.log
    originalError = console.error
    console.log = (...args: any[]) => logs.push(args.join(' '))
    console.error = (...args: any[]) => errors.push(args.join(' '))
  })

  afterEach(() => {
    console.log = originalLog
    console.error = originalError
  })

  test('jsonOutput writes JSON when json=true', () => {
    const ctx = createMockContext(true)
    const r = new Renderer(ctx)
    r.jsonOutput({ foo: 'bar', count: 42 })
    expect(logs[0]).toContain('"foo": "bar"')
    expect(logs[0]).toContain('"count": 42')
  })

  test('heading, subheading, line are no-ops in JSON mode', () => {
    const ctx = createMockContext(true)
    const r = new Renderer(ctx)
    r.heading('Title')
    r.subheading('Subtitle')
    r.line('Some line')
    expect(logs.length).toBe(0)
  })

  test('human mode outputs headings and lines', () => {
    const ctx = createMockContext(false)
    const r = new Renderer(ctx)

    r.heading('Main Title')
    r.subheading('Section')
    r.line('Hello world')
    r.line()

    expect(logs).toEqual([
      'Main Title',
      '',
      'Section',
      'Hello world',
      '',
    ])
  })

  test('list helper', () => {
    const ctx = createMockContext(false)
    const r = new Renderer(ctx)

    r.list(['item one', 'item two'], 'My List')

    expect(logs).toContain('My List')
    expect(logs).toContain('  item one')
    expect(logs).toContain('  item two')
  })

  test('keyValue helper', () => {
    const ctx = createMockContext(false)
    const r = new Renderer(ctx)

    r.keyValue('Name', 'Alice')
    r.keyValue('Age', 30)

    expect(logs[0]).toBe('  Name             Alice')
    expect(logs[1]).toBe('  Age              30')
  })

  test('render helper chooses JSON vs human', () => {
    const data = { count: 5, name: 'test' }

    // Human mode
    const humanCtx = createMockContext(false)
    const humanR = new Renderer(humanCtx)
    humanR.render(data, (d) => {
      humanR.heading(`Count: ${d.count}`)
    })
    expect(logs[0]).toBe('Count: 5')

    // JSON mode
    logs.length = 0
    const jsonCtx = createMockContext(true)
    const jsonR = new Renderer(jsonCtx)
    jsonR.render(data, () => {})
    expect(logs[0]).toContain('"count": 5')
  })

  test('error prints to stderr', () => {
    const ctx = createMockContext(false)
    const r = new Renderer(ctx)

    // Prevent actual exit
    const originalExit = process.exit
    // @ts-ignore
    process.exit = () => { throw new Error('exit called') }

    try {
      r.error('Test error message')
    } catch (_) {}

    process.exit = originalExit
    expect(errors[0]).toContain('Test error message')
  })
})
