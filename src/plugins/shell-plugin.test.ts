// code-spider-e32
import { describe, expect, test } from 'bun:test'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ShellPlugin } from './shell-plugin'

const FAKE_REGISTRY = {
  version: 1,
  capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
  languages: [
    {
      id: 'shell',
      display_name: 'Shell',
      aliases: ['bash', 'sh', 'zsh'],
      detect: { extensions: ['.sh', '.bash', '.zsh'] },
      analyzers: [
        {
          id: 'bash-language-server',
          kind: 'lsp',
          tool: 'bash-language-server',
          command: ['bash-language-server', 'start'],
          capabilities: ['symbols', 'defs', 'refs', 'diagnostics'],
          priority: 100,
        },
        {
          id: 'shell-basic-heuristic',
          kind: 'heuristic',
          tool: 'builtin',
          command: ['heuristic-symbols'],
          capabilities: ['symbols'],
          priority: 10,
        },
      ],
    },
  ],
} as const

describe('ShellPlugin.detect', () => {
  test('detects .sh extension', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const result = plugin.detect('/repo', '/repo/scripts/deploy.sh')
    expect(result.supported).toBe(true)
    expect(result.confidence).toBeGreaterThanOrEqual(0.9)
    expect(result.languageId).toBe('shell')
  })

  test('detects .bash extension', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    expect(plugin.detect('/repo', '/repo/run.bash').supported).toBe(true)
  })

  test('detects .zsh extension', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    expect(plugin.detect('/repo', '/repo/config.zsh').supported).toBe(true)
  })

  test('detects extensionless file with #!/usr/bin/env bash shebang', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const tmp = join(tmpdir(), `shell-shebang-test-${Date.now()}`)
    writeFileSync(tmp, '#!/usr/bin/env bash\necho hello\n')
    try {
      const result = plugin.detect('/repo', tmp)
      expect(result.supported).toBe(true)
      expect(result.confidence).toBe(0.7)
      expect(result.languageId).toBe('shell')
      expect(result.reason).toBe('shebang')
    } finally {
      unlinkSync(tmp)
    }
  })

  test('detects extensionless file with #!/bin/sh shebang', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const tmp = join(tmpdir(), `shell-shebang-sh-test-${Date.now()}`)
    writeFileSync(tmp, '#!/bin/sh\necho hello\n')
    try {
      expect(plugin.detect('/repo', tmp).supported).toBe(true)
    } finally {
      unlinkSync(tmp)
    }
  })

  test('rejects .ts files', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    expect(plugin.detect('/repo', '/repo/index.ts').supported).toBe(false)
  })

  test('rejects extensionless file with no shebang', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const tmp = join(tmpdir(), `no-shebang-test-${Date.now()}`)
    writeFileSync(tmp, 'echo hello\n')
    try {
      expect(plugin.detect('/repo', tmp).supported).toBe(false)
    } finally {
      unlinkSync(tmp)
    }
  })
})

describe('ShellPlugin.health', () => {
  test('available is true even without bash-language-server (heuristic fallback)', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const h = plugin.health('/repo')
    expect(h.available).toBe(true)
    expect(h.details).toContain('bash-language-server not found')
  })

  test('details undefined when bash-language-server present', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, cmd => cmd === 'bash-language-server')
    const h = plugin.health('/repo')
    expect(h.available).toBe(true)
    expect(h.details).toBeUndefined()
  })
})

describe('ShellPlugin.capabilityStatus', () => {
  test('symbols always available via heuristic', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const s = plugin.capabilityStatus('/repo')
    expect(s.symbols.supported).toBe(true)
    expect(s.symbols.available).toBe(true)
  })

  test('refs/defs/diagnostics available when LSP present', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, cmd => cmd === 'bash-language-server')
    const s = plugin.capabilityStatus('/repo')
    expect(s.references.available).toBe(true)
    expect(s.definitions.available).toBe(true)
    expect(s.diagnostics.available).toBe(true)
  })

  test('refs/defs/diagnostics unavailable without LSP', () => {
    const plugin = new ShellPlugin(FAKE_REGISTRY as any, () => false)
    const s = plugin.capabilityStatus('/repo')
    expect(s.references.available).toBe(false)
    expect(s.definitions.available).toBe(false)
    expect(s.diagnostics.available).toBe(false)
  })
})
