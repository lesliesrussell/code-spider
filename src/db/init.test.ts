// code-spider-ohm
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDb } from './init'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'code-spider-db-init-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('openDb cache .gitignore', () => {
  test('writes .gitignore excluding the index when creating .code-spider', () => {
    const db = openDb(join(root, '.code-spider', 'index.db'))
    db.close()
    const content = readFileSync(join(root, '.code-spider', '.gitignore'), 'utf8')
    expect(content).toContain('index.db*')
  })

  test('does not overwrite an existing .gitignore', () => {
    mkdirSync(join(root, '.code-spider'), { recursive: true })
    writeFileSync(join(root, '.code-spider', '.gitignore'), '# user rules\n')
    const db = openDb(join(root, '.code-spider', 'index.db'))
    db.close()
    expect(readFileSync(join(root, '.code-spider', '.gitignore'), 'utf8')).toBe('# user rules\n')
  })

  test('does not write .gitignore for non-default db locations', () => {
    const db = openDb(join(root, 'custom-dir', 'index.db'))
    db.close()
    expect(existsSync(join(root, 'custom-dir', '.gitignore'))).toBe(false)
  })
})
