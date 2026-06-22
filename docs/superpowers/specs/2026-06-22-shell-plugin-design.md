# Shell/Bash Language Plugin Design

Date: 2026-06-22

## Goal

Add first-class Shell/Bash language support to code-spider via a dedicated `ShellPlugin`, matching the architecture of `ZigPlugin` and `TypeScriptJavaScriptPlugin`. Covers heuristic symbol extraction, optional `bash-language-server` LSP integration, and `source`/`.` import edge extraction.

## Components

### 1. `config/analyzers.yaml` — Shell language entry

New language block:

- **id**: `shell`
- **display_name**: `Shell`
- **aliases**: `bash`, `sh`, `zsh`
- **extensions**: `.sh`, `.bash`, `.zsh`
- **shebang detection**: `#!/bin/sh`, `#!/bin/bash`, `#!/usr/bin/env bash`, `#!/usr/bin/env sh`, `#!/usr/bin/env zsh`
- **analyzer**: `bash-language-server`
  - kind: `semantic`
  - capabilities: `symbols`, `references`, `definitions`, `diagnostics`
  - tool: `bash-language-server`
  - degrades gracefully when not installed

### 2. `src/plugins/shared/heuristic-symbols.ts` — `shellSymbols()`

New function alongside existing `cppSymbols()` and `genericSymbols()`. Dispatched when `heuristicSymbols()` is called with language `shell`.

Patterns extracted as `Function` kind atoms:
- **Bash style**: `/^function\s+(\w+)\s*[\s(]/gm` — matches `function foo()` and `function foo (`
- **POSIX style**: `/^(\w+)\s*\(\s*\)\s*[{(]/gm` — matches `foo()` at line start followed by `{` or `(`

Dedup by name is inherited from the shared `extract()` driver. False positives guarded by requiring the POSIX pattern to anchor at line start and be followed by an opening brace/paren — prevents `if [[ $foo ]]` matches.

### 3. `src/plugins/shell-plugin.ts` — `ShellPlugin`

Extends `BaseRegistryPlugin`. Same shape as `ZigPlugin`.

**`matchesLanguage(language)`**: returns true when `language.id === 'shell'`

**`detect(repoRoot, filePath)`**:
- Extension match (`.sh`, `.bash`, `.zsh`) → confidence 0.9
- Shebang line read fallback for extensionless files → confidence 0.7
- Returns unsupported otherwise

**`health(repoRoot)`**: reports `bash-language-server` present/absent via `commandExists`

**`capabilityStatus(repoRoot)`**:
- `symbols`: always `available` (heuristic)
- `references`, `definitions`, `diagnostics`: `available` if `bash-language-server` installed, `unavailable` otherwise
- `health`: mirrors `health()`

**`extractSourceImports(filePath)`** (new method, not on base interface):
- Returns `{ from: string, to: string }[]`
- Scans file content for `source <path>` and `. <path>` patterns
- Ignores commented-out lines (lines starting with `#`)
- Resolves relative paths against `filePath`'s directory
- Called by the semantic enricher for `.sh` files to write `imports` edges (same invocation pattern as `cross-language-refs.ts`)

### 4. `src/language-plugin-registry.ts` — Registration

Add `ShellPlugin` to `this.plugins` array alongside `TypeScriptJavaScriptPlugin`, `ZigPlugin`, and `CppPlugin`.

### 5. `src/plugins/shell-plugin.test.ts` — Tests

- `detect` returns supported for `.sh`, `.bash`, `.zsh` extensions
- `detect` returns supported for shebang-only files (`#!/bin/bash`, `#!/usr/bin/env sh`)
- `detect` returns unsupported for unrelated extensions
- `health` returns available when `bash-language-server` in PATH, unavailable otherwise
- `capabilityStatus` reflects LSP availability correctly
- `extractSourceImports` parses `source ./lib.sh` and `. ./utils.sh`
- `extractSourceImports` ignores `# source ./commented.sh`
- `shellSymbols` (in `heuristic-symbols.test.ts`) extracts both function styles
- `shellSymbols` does not match `if`/`while`/`for` constructs as functions

## Data Flow

```
.sh file ingested
  → ShellPlugin.detect() → supported
  → BasePlugin.getSymbols()
      → heuristicSymbols(source, 'shell') → shellSymbols() → Function atoms
      → bash-language-server LSP (if available) → additional symbols
  → ShellPlugin.extractSourceImports()
      → semantic enricher writes imports edges
  → BasePlugin.getDiagnostics() / getReferences() / getDefinitions()
      → bash-language-server LSP (if available), else unsupported result
```

## Constraints

- **Fail soft**: missing `bash-language-server` degrades to heuristic-only; no crash
- **No new base interface changes**: `extractSourceImports` is shell-specific; semantic enricher calls it via type-narrowing or a duck-type check
- **Heuristic always runs**: even when LSP is present, heuristic symbols run as the structural fallback layer
