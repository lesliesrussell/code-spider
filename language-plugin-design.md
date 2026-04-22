# Language Plugin Design

## Goal

Move language-specific analysis behind a typed plugin contract so `code-spider` core can orchestrate languages as black boxes with a strict, normalized API.

The core should know:

- how to select a plugin
- which capabilities a plugin claims
- how to call the plugin
- how to store normalized results
- how to report degradation honestly

The core should not know:

- LSP lifecycle quirks
- language-specific symbol normalization rules
- workspace hydration tricks
- tool-specific fallback behavior
- language-specific noise filtering heuristics

## Problem With The Current Design

Today the analyzer registry describes language metadata, but execution behavior still lives in shared core code.

The main leaks are:

- `AnalyzerRunner` chooses tools and also knows how to run LSP, quality, and heuristic flows
- `LspAdapter` mixes transport, normalization, workspace policy, and symbol-signal classification
- command behavior and health reporting depend on analyzer-kind assumptions
- capability semantics differ by kind even though they look uniform in the registry

This means the registry is currently selection metadata, not a full plugin boundary.

## Target Architecture

Keep two layers:

### 1. Whitebox Core

Responsible for:

- repo detection and indexing orchestration
- graph/schema writes
- analyzer run telemetry
- generic command surfaces
- cross-language result presentation
- plugin selection and lifecycle at a high level

### 2. Blackbox Language Plugins

Responsible for:

- language detection confidence
- tool startup and lifecycle
- defs/refs/symbols/diagnostics execution
- normalized result shaping
- degradation and fallback semantics
- language-specific signal classification

The core consumes only the plugin contract and normalized payloads.

## Plugin Contract

The initial contract is captured in [src/language-plugin.ts](/Users/leslierussell/repo/code-spider/src/language-plugin.ts:1).

The important decisions are:

- the plugin owns capability execution, not just tool metadata
- every capability returns normalized data through `PluginResult<T>`
- degradation is first-class and explicit
- health and capability availability are separate from query execution
- symbol signal quality is part of the returned API, not inferred later by ranking consumers

## Core Types To Standardize

The API must normalize:

- positions and ranges
- symbol kind strings
- symbol anchors via `selectionRange`
- diagnostic severities
- provenance such as `semantic` vs `heuristic`
- low-signal symbol classification
- degradation reason strings

The contract should be strict on failure semantics, not just happy-path payloads.

## What Stays In The Registry

The existing analyzer registry is still useful, but its role changes.

It should remain a source of:

- language identifiers
- aliases
- detection hints like extensions and manifests
- built-in plugin registration metadata
- maybe default tool configuration

It should stop being the thing that defines execution behavior directly.

In other words:

- registry = static selection/config metadata
- plugin = executable behavior

## Migration Shape

Do this incrementally.

### Phase 1: Introduce The Contract

- add the shared plugin types
- write the migration design down
- do not change user-facing behavior yet

### Phase 2: Add A Built-In Plugin Registry

- introduce a core `LanguagePluginRegistry`
- register built-in plugins in code
- let the core resolve `languageId -> plugin`

### Phase 3: Wrap Current TypeScript/JavaScript Support

- create a built-in plugin for the current TypeScript/JavaScript path
- move LSP lifecycle and workspace hydration policy behind that plugin
- move heuristic symbol fallback behind that plugin
- keep the core telemetry and persistence unchanged

### Phase 4: Wrap Zig Support

- move `zls` lifecycle rules and Zig-specific diagnostics behavior into a Zig plugin
- keep Zig-specific protocol handling out of shared LSP orchestration

### Phase 5: Narrow AnalyzerRunner

`AnalyzerRunner` should shrink into a generic plugin orchestrator:

- resolve plugin
- call capability method
- record telemetry
- return normalized results

It should no longer branch on analyzer kind or know about LSP-specific flow.

### Phase 6: Revisit The Registry

Once built-in plugins are stable:

- either keep the YAML registry as plugin metadata input
- or replace it with a code-first built-in plugin list

That decision can wait until the execution boundary is real.

## Contract Boundaries That Matter

### Detection

Detection should return:

- supported or not
- confidence
- optional reason

This prevents the core from hardcoding extension-only assumptions forever.

### Capability Status

Plugins should report capability support and availability separately.

Examples:

- supports refs, but tool missing
- supports diagnostics, but degraded outside a workspace
- supports symbols only heuristically in the current environment

That lets `doctor` stay honest without conflating static support with last-run execution.

### Degradation

Degradation must be explicit in results.

Examples:

- fell back to indexed-name references
- returned heuristic symbols instead of semantic symbols
- diagnostics unavailable because project manifest was missing

If degradation is not part of the contract, the core will keep guessing from partial signals.

## Mapping From Current Code

Current responsibilities should move like this:

- `src/services/analyzer-runner.ts`
  - keep telemetry and orchestration
  - lose analyzer-kind branching and most execution policy

- `src/adapters/lsp.ts`
  - split into reusable transport helpers plus plugin-local behavior
  - stop acting like the shared semantic abstraction for all languages

- heuristic symbol extraction in `AnalyzerRunner`
  - move into the relevant built-in language plugin

- symbol signal tagging
  - already moving in the right direction
  - should remain plugin-owned, not ranking-owned

## Non-Goals For The First Cut

Do not do these in the first refactor:

- dynamic third-party plugin loading
- plugin distribution or marketplace behavior
- full sandboxing model for external plugins
- cross-process plugin RPC

Start with in-repo built-in plugins behind a strict typed interface.

That gets the architectural separation without adding packaging complexity.

## Success Criteria

We will know the design is real when:

- `AnalyzerRunner` no longer switches on analyzer kind for capability execution
- `LspAdapter` is no longer the shared language abstraction
- TypeScript/Zig quirks live in their own built-in plugins
- `doctor`, `refs`, and `atoms` still behave the same from the user’s perspective
- the core only consumes normalized plugin results and capability status

