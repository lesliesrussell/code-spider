// code-spider-ua1
import { describe, expect, test } from 'bun:test'
import { buildClangTidyArgs, buildCppcheckArgs, findCompileDb, parseToolOutput } from './cpp-quality'

describe('buildClangTidyArgs', () => {
  test('runs quietly with no -p when there is no compile database', () => {
    expect(buildClangTidyArgs('/r/a.c')).toEqual(['/r/a.c', '--quiet'])
  })

  test('injects -p <dir> when a compile database directory is supplied', () => {
    expect(buildClangTidyArgs('/r/a.c', '/r/build')).toEqual(['/r/a.c', '--quiet', '-p', '/r/build'])
  })
})

describe('buildCppcheckArgs', () => {
  test('passes the template so output matches the shared parser shape', () => {
    expect(buildCppcheckArgs('/r/a.c')).toEqual([
      '/r/a.c',
      '--quiet',
      '--enable=warning,performance,portability',
      '--template={file}:{line}:{column}: {severity}: {message} [{id}]',
    ])
  })
})

describe('findCompileDb', () => {
  const dbAt = (...dirs: string[]) => {
    const present = new Set(dirs.map(d => `${d}/compile_commands.json`))
    return { existsSync: (p: string) => present.has(p), readdirSync: () => [] }
  }

  test('returns the repo root when compile_commands.json sits there', () => {
    expect(findCompileDb('/repo', dbAt('/repo'))).toBe('/repo')
  })

  test('finds it under build/', () => {
    expect(findCompileDb('/repo', dbAt('/repo/build'))).toBe('/repo/build')
  })

  test('finds it under a cmake-build-* directory discovered via readdir', () => {
    const deps = {
      existsSync: (p: string) => p === '/repo/cmake-build-debug/compile_commands.json',
      readdirSync: () => ['src', 'cmake-build-debug', 'README.md'],
    }
    expect(findCompileDb('/repo', deps)).toBe('/repo/cmake-build-debug')
  })

  test('returns undefined when no compile database exists', () => {
    expect(findCompileDb('/repo', dbAt())).toBeUndefined()
  })
})

describe('parseToolOutput', () => {
  test('reads clang-tidy from stdout', () => {
    const stdout = '/r/a.c:1:1: warning: msg [some-check]'
    const diags = parseToolOutput('clang-tidy', stdout, 'ignored stderr noise')
    expect(diags).toHaveLength(1)
    expect(diags[0]?.code).toBe('some-check')
  })

  test('reads cppcheck from stderr', () => {
    const stderr = '/r/a.c:2:3: error: Null pointer [nullPointer]'
    const diags = parseToolOutput('cppcheck', 'ignored stdout', stderr)
    expect(diags).toHaveLength(1)
    expect(diags[0]?.severity).toBe(1)
  })

  test('returns nothing for an unrecognized tool', () => {
    expect(parseToolOutput('gcc', 'x', 'y')).toEqual([])
  })
})
