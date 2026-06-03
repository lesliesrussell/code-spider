// code-spider-c6v
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { FilesystemAdapter, buildIgnoreRules, shouldIgnoreFile } from './filesystem'
import { collectWorkspaceFiles } from './lsp'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'code-spider-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function writeConfig(yaml: string): void {
  mkdirSync(join(root, '.code-spider'), { recursive: true })
  writeFileSync(join(root, '.code-spider', 'config.yaml'), yaml)
}

describe('buildIgnoreRules', () => {
  test('includes self-referential defaults without any config', () => {
    const rules = buildIgnoreRules(root)
    for (const dir of ['.git', 'node_modules', '.code-spider', '.beads', '.claude', '.nardo', '.omc', '.zig-cache', 'zig-out']) {
      expect(rules.dirNames.has(dir)).toBe(true)
    }
    expect(rules.globs).toEqual([])
  })

  test('merges config dirs and globs with defaults', () => {
    writeConfig([
      'ignore:',
      '  dirs:',
      '    - generated',
      '    - .mycache',
      '  globs:',
      '    - "*.db"',
      '    - "*.db-wal"',
    ].join('\n'))

    const rules = buildIgnoreRules(root)
    expect(rules.dirNames.has('generated')).toBe(true)
    expect(rules.dirNames.has('.mycache')).toBe(true)
    expect(rules.dirNames.has('node_modules')).toBe(true)
    expect(rules.globs).toEqual(['*.db', '*.db-wal'])
    expect(shouldIgnoreFile('index.db', rules)).toBe(true)
    expect(shouldIgnoreFile('nested/index.db-wal', rules)).toBe(true)
    expect(shouldIgnoreFile('src/index.ts', rules)).toBe(false)
  })
})

describe('FilesystemAdapter.walk with config ignores', () => {
  test('excludes config-ignored dirs and globs from the walk', async () => {
    writeConfig([
      'ignore:',
      '  dirs:',
      '    - generated',
      '  globs:',
      '    - "*.db"',
    ].join('\n'))

    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'generated'))
    writeFileSync(join(root, 'src', 'app.ts'), 'export {}')
    writeFileSync(join(root, 'src', 'index.db'), 'binary')
    writeFileSync(join(root, 'generated', 'out.ts'), 'export {}')

    const files = await new FilesystemAdapter().walk(root)
    const relPaths = files.map(f => f.relPath)
    expect(relPaths).toContain('src/app.ts')
    expect(relPaths).not.toContain('src/index.db')
    expect(relPaths).not.toContain('generated/out.ts')
  })

  test('excludes default self-referential dirs from the walk', async () => {
    mkdirSync(join(root, '.code-spider'))
    mkdirSync(join(root, '.omc'))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, '.code-spider', 'index.db'), 'binary')
    writeFileSync(join(root, '.omc', 'state.json'), '{}')
    writeFileSync(join(root, 'src', 'app.ts'), 'export {}')

    const files = await new FilesystemAdapter().walk(root)
    const relPaths = files.map(f => f.relPath)
    expect(relPaths).toEqual(['src/app.ts'])
  })
})

// code-spider-ofm
describe('FilesystemAdapter.walk language overrides', () => {
  test('registry-declared extensions map to their language; builtin map still applies', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'core.lisp'), '(define x 1)')
    writeFileSync(join(root, 'src', 'app.ts'), 'export {}')

    const files = await new FilesystemAdapter().walk(root, { '.lisp': 'Lisp' })
    const byPath = new Map(files.map(f => [f.relPath, f.language]))
    expect(byPath.get('src/core.lisp')).toBe('Lisp')
    expect(byPath.get('src/app.ts')).toBe('TypeScript')
  })
})

describe('collectWorkspaceFiles with config ignores', () => {
  test('excludes config-ignored dirs and globs', () => {
    writeConfig([
      'ignore:',
      '  dirs:',
      '    - generated',
      '  globs:',
      '    - "*.gen.ts"',
    ].join('\n'))

    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'generated'))
    mkdirSync(join(root, 'node_modules'))
    writeFileSync(join(root, 'src', 'app.ts'), 'export {}')
    writeFileSync(join(root, 'src', 'schema.gen.ts'), 'export {}')
    writeFileSync(join(root, 'generated', 'out.ts'), 'export {}')
    writeFileSync(join(root, 'node_modules', 'dep.ts'), 'export {}')

    const files = collectWorkspaceFiles(root, ['.ts'])
    expect(files).toEqual([join(root, 'src', 'app.ts')])
  })
})
