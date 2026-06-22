# Shell/Bash Language Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add first-class Shell/Bash language support to code-spider via a `ShellPlugin`, covering heuristic symbol extraction, optional `bash-language-server` LSP integration, and `source`/`.` import edge wiring.

**Architecture:** `ShellPlugin` extends `BaseRegistryPlugin` (same pattern as `ZigPlugin`). Shell symbol heuristics live in `heuristic-symbols.ts` alongside existing C/C++ and generic extractors. Shell `source`/`.` import scanning extends `import-edges.ts` so it flows through the existing `scanUnitImports` → `insertImportEdge` pipeline in the indexer.

**Tech Stack:** TypeScript, Bun test, `bash-language-server` (optional LSP), regex heuristics.

## Global Constraints

- Fail soft: missing `bash-language-server` degrades to heuristic-only; never crash
- Heuristic symbols always run regardless of LSP availability
- YAML registry capabilities use `defs`/`refs`; plugin code uses `definitions`/`references` — `getCandidates()` maps between them at line 402 of `base-plugin.ts`
- All tests run with `bun test`; full suite must stay green
- Follow bead workflow: create a bead before writing code, branch name = bead ID

---

## File Map

| Action | Path | Responsibility |
|--------|------|----------------|
| Modify | `config/analyzers.yaml` | Add `shell` language entry with `bash-language-server` + heuristic analyzers |
| Modify | `src/plugins/shared/heuristic-symbols.ts` | Add `shellSymbols()` and dispatch in `heuristicSymbols()` |
| Modify | `src/plugins/shared/heuristic-symbols.test.ts` | Shell heuristic extraction tests |
| Create | `src/plugins/shell-plugin.ts` | `ShellPlugin` class |
| Create | `src/plugins/shell-plugin.test.ts` | `ShellPlugin` unit tests |
| Modify | `src/services/import-edges.ts` | Add `scanShellSpecifiers()` + shell branch in `scanFileSpecifiers()` |
| Modify | `src/services/import-edges.test.ts` | Shell source import edge tests |
| Modify | `src/language-plugin-registry.ts` | Register `ShellPlugin` |

---

## Task 1: Shell registry entry + heuristic symbols

**Files:**
- Modify: `config/analyzers.yaml`
- Modify: `src/plugins/shared/heuristic-symbols.ts`
- Modify: `src/plugins/shared/heuristic-symbols.test.ts`

**Interfaces:**
- Produces: `heuristicSymbols(source, 'shell')` returns `LspSymbol[]` with `Function` atoms
- Produces: `shell` language entry in registry with id `shell`, extensions `.sh`/`.bash`/`.zsh`

- [ ] **Step 1: Create a bead for this work**

```bash
bd create --title="Shell/Bash language plugin" \
  --description="Add ShellPlugin with heuristic symbols, bash-language-server LSP, and source import edges. Spec: docs/superpowers/specs/2026-06-22-shell-plugin-design.md" \
  --type=feature --priority=2
# Note the bead ID (e.g. code-spider-xyz)
bd update code-spider-xyz --claim
git checkout -b code-spider-xyz
```

- [ ] **Step 2: Write failing shell heuristic tests**

Add to `src/plugins/shared/heuristic-symbols.test.ts` after the existing describe blocks:

```typescript
const SHELL_SOURCE = `#!/bin/bash
# A comment

function greet() {
  echo "hello"
}

function _private_func() {
  :
}

deploy() {
  echo "deploying"
}

build_all () {
  echo "building"
}

# Not a function — shell keyword:
if [ -z "$var" ]; then
  echo "empty"
fi

while true; do
  break
done
`

describe('heuristicSymbols (Shell)', () => {
  test('extracts bash-style function keyword declarations', () => {
    const names = heuristicSymbols(SHELL_SOURCE, 'shell').map(s => s.name)
    expect(names).toContain('greet')
    expect(names).toContain('_private_func')
  })

  test('extracts POSIX-style foo() declarations', () => {
    const names = heuristicSymbols(SHELL_SOURCE, 'shell').map(s => s.name)
    expect(names).toContain('deploy')
    expect(names).toContain('build_all')
  })

  test('does not emit shell keywords as functions', () => {
    const names = heuristicSymbols(SHELL_SOURCE, 'shell').map(s => s.name)
    expect(names).not.toContain('if')
    expect(names).not.toContain('for')
    expect(names).not.toContain('while')
    expect(names).not.toContain('until')
    expect(names).not.toContain('case')
  })

  test('all extracted symbols have Function kind', () => {
    const syms = heuristicSymbols(SHELL_SOURCE, 'shell')
    expect(syms.length).toBeGreaterThan(0)
    for (const s of syms) {
      expect(s.kindName).toBe('Function')
    }
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
bun test src/plugins/shared/heuristic-symbols.test.ts
```

Expected: tests in `heuristicSymbols (Shell)` fail with "Expected ... to contain ..." or similar.

- [ ] **Step 4: Add `shellSymbols()` to `heuristic-symbols.ts`**

In `src/plugins/shared/heuristic-symbols.ts`, update the `heuristicSymbols` dispatcher and add `shellSymbols`:

```typescript
// code-spider-xyz
export function heuristicSymbols(source: string, language?: string): LspSymbol[] {
  if (language === 'c' || language === 'cpp') return cppSymbols(source)
  if (language === 'shell') return shellSymbols(source)
  return genericSymbols(source)
}
```

Then add `shellSymbols` after `cppSymbols`:

```typescript
// code-spider-xyz
const SHELL_FUNCTION_BLACKLIST = new Set([
  'if', 'for', 'while', 'until', 'case', 'select',
  'return', 'do', 'done', 'fi', 'esac', 'then', 'else',
])

function shellSymbols(source: string): LspSymbol[] {
  const patterns: NamePattern[] = [
    // bash keyword style: "function foo" / "function foo()" / "function foo {"
    { re: /^function\s+(\w+)/gm, kind: 12, kindName: 'Function' },
    // POSIX style: "foo()" at line start with optional whitespace before/after parens
    { re: /^\s*(\w+)\s*\(\s*\)/gm, kind: 12, kindName: 'Function' },
  ]
  return extract(source, patterns, SHELL_FUNCTION_BLACKLIST)
}
```

- [ ] **Step 5: Run tests to confirm they pass**

```bash
bun test src/plugins/shared/heuristic-symbols.test.ts
```

Expected: all tests pass including the new Shell describe block.

- [ ] **Step 6: Add shell language entry to `config/analyzers.yaml`**

Append at the end of the file (after the last C++ entry):

```yaml
  - id: shell
    display_name: Shell
    aliases:
      - bash
      - sh
      - zsh
    detect:
      extensions:
        - .sh
        - .bash
        - .zsh
    analyzers:
      - id: bash-language-server
        kind: lsp
        tool: bash-language-server
        command:
          - bash-language-server
          - start
        capabilities:
          - symbols
          - defs
          - refs
          - diagnostics
        priority: 100
      - id: shell-basic-heuristic
        kind: heuristic
        tool: builtin
        command:
          - heuristic-symbols
        capabilities:
          - symbols
        priority: 10
        notes: Built-in fallback symbol extraction for Shell scripts when bash-language-server is unavailable.
```

- [ ] **Step 7: Verify the registry loads cleanly**

```bash
bun test src/analyzer-registry-loader.test.ts
```

Expected: all tests pass.

- [ ] **Step 8: Commit**

```bash
git add config/analyzers.yaml \
        src/plugins/shared/heuristic-symbols.ts \
        src/plugins/shared/heuristic-symbols.test.ts
git commit -m "// code-spider-xyz

feat: add shell heuristic symbols and registry entry"
```

---

## Task 2: ShellPlugin class + tests

**Files:**
- Create: `src/plugins/shell-plugin.ts`
- Create: `src/plugins/shell-plugin.test.ts`

**Interfaces:**
- Consumes: `BaseRegistryPlugin` from `./base-plugin`, registry with `shell` language entry (Task 1)
- Consumes: `findLanguageFromPath(filePath)` → `RegistryLanguage | undefined` (inherited)
- Consumes: `getCandidates(repoRoot, 'shell', capability)` → `ResolvedAnalyzer[]` (inherited)
- Consumes: `this.commandExists(bin)` → `boolean` (injected via constructor)
- Produces: `ShellPlugin` class (exported) with `detect`, `health`, `capabilityStatus`

- [ ] **Step 1: Write failing tests**

Create `src/plugins/shell-plugin.test.ts`:

```typescript
// code-spider-xyz
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
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/plugins/shell-plugin.test.ts
```

Expected: fails because `./shell-plugin` does not exist.

- [ ] **Step 3: Implement `shell-plugin.ts`**

Create `src/plugins/shell-plugin.ts`:

```typescript
// code-spider-xyz
import { readFileSync } from 'node:fs'
import type { RegistryLanguage } from '../analyzer-registry'
import type {
  PluginCapabilityStatus,
  PluginDetectionResult,
  PluginHealth,
} from '../language-plugin'
import { BaseRegistryPlugin, type PluginCapability } from './base-plugin'

const SHEBANG_RE = /^#!.*\b(bash|sh|zsh)\b/

export class ShellPlugin extends BaseRegistryPlugin {
  readonly id = 'builtin.shell'
  readonly displayName = 'Built-in Shell Plugin'
  readonly languageIds = ['shell']
  readonly capabilities = ['symbols', 'diagnostics', 'references', 'definitions', 'health'] as const

  protected matchesLanguage(language: RegistryLanguage): boolean {
    return language.id === 'shell'
  }

  detect(_repoRoot: string, filePath: string): PluginDetectionResult {
    const language = this.findLanguageFromPath(filePath)
    if (language !== undefined) {
      return { supported: true, confidence: 0.9, languageId: language.id }
    }
    try {
      const firstLine = readFileSync(filePath, 'utf8').split('\n')[0] ?? ''
      if (SHEBANG_RE.test(firstLine)) {
        return { supported: true, confidence: 0.7, languageId: 'shell', reason: 'shebang' }
      }
    } catch {
      // unreadable file — not our language
    }
    return { supported: false, confidence: 0 }
  }

  health(_repoRoot: string): PluginHealth {
    const hasLsp = this.commandExists('bash-language-server')
    return {
      available: true,
      toolName: 'bash-language-server',
      details: hasLsp ? undefined : 'bash-language-server not found; heuristic symbols only',
    }
  }

  capabilityStatus(repoRoot: string): Record<'symbols' | 'definitions' | 'references' | 'diagnostics' | 'health', PluginCapabilityStatus> {
    const supports = (capability: PluginCapability): PluginCapabilityStatus => {
      const candidates = this.getCandidates(repoRoot, 'shell', capability)
      const available = candidates.some(candidate =>
        candidate.analyzer.kind === 'heuristic' || this.commandExists(candidate.analyzer.command[0] ?? ''),
      )
      return { supported: candidates.length > 0, available }
    }

    return {
      symbols: supports('symbols'),
      definitions: supports('definitions'),
      references: supports('references'),
      diagnostics: supports('diagnostics'),
      health: { supported: true, available: true },
    }
  }
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/plugins/shell-plugin.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Type-check**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/plugins/shell-plugin.ts src/plugins/shell-plugin.test.ts
git commit -m "// code-spider-xyz

feat: implement ShellPlugin with detect, health, capabilityStatus"
```

---

## Task 3: Shell source import edges

**Files:**
- Modify: `src/services/import-edges.ts`
- Modify: `src/services/import-edges.test.ts`

**Interfaces:**
- Consumes: `scanFileSpecifiers(repoRoot, relPath)` — existing export; shell branch added before the TS/JS loader check (line ~86)
- Produces: `source ./x` and `. ./x` directives flow through `scanUnitImports` → indexer `insertImportEdge` as `imports` edges with `confidence: 1`
- Note: `extractSourceImports` from the design spec is implemented here as `scanShellSpecifiers()` rather than on `ShellPlugin` — keeps all file-level import scanning in one place

- [ ] **Step 1: Write failing shell import tests**

Add to `src/services/import-edges.test.ts` after the existing `describe('scanUnitImports', ...)` block:

```typescript
describe('scanUnitImports (shell)', () => {
  test('resolves source ./path.sh imports', async () => {
    const root = makeRepo({
      'scripts/deploy.sh': 'source ./lib.sh\necho "deploying"',
      'scripts/lib.sh': 'function setup() { echo "setup"; }',
    })
    const records = await scanUnitImports(root, ['scripts/deploy.sh', 'scripts/lib.sh'])
    expect(records).toEqual([{ fromPath: 'scripts/deploy.sh', toPath: 'scripts/lib.sh', confidence: 1 }])
  })

  test('resolves . ./path.sh imports (POSIX dot operator)', async () => {
    const root = makeRepo({
      'scripts/main.sh': '. ./utils.sh\necho "main"',
      'scripts/utils.sh': 'UTIL_VAR=1',
    })
    const records = await scanUnitImports(root, ['scripts/main.sh', 'scripts/utils.sh'])
    expect(records).toEqual([{ fromPath: 'scripts/main.sh', toPath: 'scripts/utils.sh', confidence: 1 }])
  })

  test('ignores commented-out source lines', async () => {
    const root = makeRepo({
      'scripts/a.sh': '# source ./b.sh\necho "a"',
      'scripts/b.sh': 'echo "b"',
    })
    const records = await scanUnitImports(root, ['scripts/a.sh', 'scripts/b.sh'])
    expect(records).toHaveLength(0)
  })

  test('ignores bare-name sources that are not repo-relative paths', async () => {
    const root = makeRepo({
      'scripts/a.sh': 'source somelib\necho "a"',
      'scripts/b.sh': 'echo "b"',
    })
    const records = await scanUnitImports(root, ['scripts/a.sh', 'scripts/b.sh'])
    expect(records).toHaveLength(0)
  })

  test('resolves indented source inside if-block', async () => {
    const root = makeRepo({
      'scripts/a.sh': 'if true; then\n  source ./b.sh\nfi',
      'scripts/b.sh': 'echo "b"',
    })
    const records = await scanUnitImports(root, ['scripts/a.sh', 'scripts/b.sh'])
    expect(records).toEqual([{ fromPath: 'scripts/a.sh', toPath: 'scripts/b.sh', confidence: 1 }])
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
bun test src/services/import-edges.test.ts
```

Expected: the new shell describe block fails with 0 records found.

- [ ] **Step 3: Add `scanShellSpecifiers` and shell branch to `import-edges.ts`**

Add after the `DYNAMIC_IMPORT_CONFIDENCE` constant and before `loaderFor`:

```typescript
// code-spider-xyz
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh'])

function scanShellSpecifiers(source: string): string[] {
  // Matches: optional leading whitespace, then 'source' or '.', then whitespace, then a path.
  // ^\s* in /gm mode anchors to line start — '#' at line start prevents match.
  const re = /^\s*(?:source|\.)\s+(['"]?)([^\s'"#]+)\1/gm
  const specifiers: string[] = []
  let match: RegExpExecArray | null
  while ((match = re.exec(source)) !== null) {
    const spec = match[2]
    if (spec !== undefined) specifiers.push(spec)
  }
  return specifiers
}
```

Then in `scanFileSpecifiers`, add a shell branch **before** `const loader = loaderFor(relPath)`:

```typescript
export async function scanFileSpecifiers(
  repoRoot: string,
  relPath: string
): Promise<Array<{ path: string; kind: string }>> {
  // code-spider-xyz: shell source/. imports
  const dot = relPath.lastIndexOf('.')
  const ext = dot !== -1 ? relPath.slice(dot) : ''
  if (SHELL_EXTENSIONS.has(ext)) {
    try {
      const source = await Bun.file(join(repoRoot, relPath)).text()
      return scanShellSpecifiers(source).map(path => ({ path, kind: 'import-statement' }))
    } catch (err) {
      debugLog('import-edges', `shell scan failed for ${relPath}`, err)
      return []
    }
  }

  const loader = loaderFor(relPath)
  // ... rest of existing function unchanged
```

- [ ] **Step 4: Run tests to confirm they pass**

```bash
bun test src/services/import-edges.test.ts
```

Expected: all tests pass including the new shell describe block.

- [ ] **Step 5: Run full suite to check for regressions**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/services/import-edges.ts src/services/import-edges.test.ts
git commit -m "// code-spider-xyz

feat: add shell source import edge scanning to import-edges"
```

---

## Task 4: Register ShellPlugin

**Files:**
- Modify: `src/language-plugin-registry.ts`

**Interfaces:**
- Consumes: `ShellPlugin` from `./plugins/shell-plugin` (Task 2)
- Produces: `BuiltinLanguagePluginRegistry` routes `.sh`/`.bash`/`.zsh` files through `ShellPlugin`

- [ ] **Step 1: Add the import and registration**

In `src/language-plugin-registry.ts`, add the import after the existing plugin imports:

```typescript
// code-spider-xyz
import { ShellPlugin } from './plugins/shell-plugin'
```

Then in the `constructor`, add `ShellPlugin` to `this.plugins`:

```typescript
this.plugins = [
  new TypeScriptJavaScriptPlugin(registry, commandExists, lsp),
  new ZigPlugin(registry, commandExists, lsp),
  // code-spider-due
  new CppPlugin(registry, commandExists, lsp),
  // code-spider-xyz
  new ShellPlugin(registry, commandExists, lsp),
]
```

- [ ] **Step 2: Run full test suite**

```bash
bun test
```

Expected: all tests pass.

- [ ] **Step 3: Type-check**

```bash
bun run typecheck
```

Expected: no errors.

- [ ] **Step 4: Smoke test with the CLI (optional but recommended)**

If a shell script repo is available:

```bash
bun run src/index.ts doctor
# Should show Shell language in supported language list
```

- [ ] **Step 5: Commit and close**

```bash
git add src/language-plugin-registry.ts
git commit -m "// code-spider-xyz

feat: register ShellPlugin in BuiltinLanguagePluginRegistry"

git checkout master
git merge code-spider-xyz
git branch -d code-spider-xyz
bd close code-spider-xyz
bd dolt push
git push
```
