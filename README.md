# code-spider

Repository indexing and analysis CLI. Builds a structured, evidence-rich view of any codebase to power trustworthy investigation by AI agents (Claude Code, Codex, and similar autonomous tools).

Designed for deep exploration: languages, zones, hotspots, git context, markdown documentation, work tracking (beads), semantic symbols/refs, and a "doctor" health check that tells you exactly what signals you can trust.

## Features

- **Non-destructive `inspect`** — quick structural overview without writing to the repo
- **Persistent indexing** — builds a SQLite database (`.code-spider/index.db` or custom `--db`)
- **Doctor command** — reports environment, selected language plugins/analyzers, context enrichers, and analysis fidelity (structural, semantic, git, markdown, beads)
- **Rich navigation**:
  - `overview`, `zones`, `show <node>`, `children`, `related`, `flows`
  - Semantic: `defs`, `refs`, `atoms`
  - Natural-language search: `find "<query>"` over `index --embed` vectors
    (local ollama + nomic-embed-text; optional, fails soft)
  - Investigation management (notes, pinned evidence) and report export
  - Every command supports `--json`
- **Incremental re-index** — `index --semantic --embed --incremental` reuses
  results for unchanged files (observed 64s → ~1s on this repo)
- **Context layers**:
  - Git history, co-changes, commit rationale
  - Markdown sections and nearby documentation
  - Beads (issues, tasks, dependencies)
- **Language plugins** — first-class support for TypeScript/JavaScript (tsserver LSP + heuristic) and Zig (zls + zig-ast-check). Extensible registry.
- **Hotspot & flow analysis** — identifies active areas and logical subsystems
- **Intelligence findings** — dead code, dependency cycles, duplication, risk
  hotspots, and architecture-rule violations as stable, evidence-backed,
  CI-trackable findings (`intelligence scan`, see below)

Perfect companion for the `code-spider-claude` and `code-spider-codex` skills included in this repository.

## Quick Start

```bash
# Get dependencies
bun install

# Option A: link globally (runs from source via bun)
bun link            # puts `code-spider` on PATH (~/.bun/bin)

# Option B: standalone single-file binary (no bun needed to run it)
bun run build       # produces dist/code-spider (~60MB, registry embedded)
cp dist/code-spider ~/bin/   # or anywhere on your PATH

# Basic investigation flow
code-spider inspect .                    # Non-destructive first pass
code-spider index . --db /tmp/myrepo.db  # Build persistent index
code-spider doctor --db /tmp/myrepo.db   # Check what is trustworthy
code-spider overview --db /tmp/myrepo.db
code-spider zones --db /tmp/myrepo.db --limit 10
```

For semantic depth (symbols, references, diagnostics):
```bash
code-spider index . --db /tmp/myrepo.db --semantic
code-spider doctor --db /tmp/myrepo.db
code-spider show unit:src/services/doctor.ts --db /tmp/myrepo.db
code-spider related unit:src/services/doctor.ts --db /tmp/myrepo.db
```

### Recommended Investigation Sequence (for AI agents)

See `skills/code-spider-claude/SKILL.md` for detailed patterns.

1. Start with `inspect`
2. Index to a stable DB (use `--db /tmp/...` during exploration)
3. Run `doctor` to understand fidelity
4. Use `overview` → `zones` → `show` + `related` + `flows` for reading plans
5. Add semantic queries (`defs`, `refs`, `atoms`) when doctor confirms they are healthy
6. Export reports or manage `investigate` sessions

Create `.code-spider/config.yaml` to ignore caches, generated dirs, or self-referential folders:

```yaml
ignore:
  dirs:
    - .code-spider
    - .claude
    - .nardo
    - .omc
    - .zig-cache
    - zig-out
    - node_modules
  globs:
    - "*.db"
    - "*.db-wal"
    - "*.db-shm"
```

Flow detection is Node/web-centric out of the box; extend it for other
ecosystems with a `flows:` section. Each category (route/queue/event/cli)
contributes at most one strong signal no matter how many entries match —
config widens detection but cannot inflate confidence:

```yaml
flows:
  route_deps:        # extra package.json deps treated as web frameworks
    - flask
  route_patterns:    # extra rg regexes for route registration call sites
    - "@app\.route\("
  queue_deps:
    - celery
  queue_patterns:
    - "@task\("
  event_deps: []
  event_patterns: []
  cli_patterns:
    - "argparse\.ArgumentParser"
```

## Intelligence Findings

A static-analysis suite over the index: every claim is a *finding* with a
stable fingerprint (survives line drift — CI and agents can track it across
runs), a confidence level, and supporting evidence on request.

```bash
code-spider intelligence scan                 # run all analyzers, list findings
code-spider intelligence scan --format md     # markdown report (also: json, sarif)
code-spider intelligence cycles               # circular dependencies (Tarjan SCC)
code-spider intelligence unused               # files/deps/symbols unreachable from entrypoints
code-spider intelligence dupes                # duplicated files, regions, clone classes
code-spider intelligence hotspots             # weighted composite risk ranking
code-spider intelligence arch                 # declared layer/boundary rule violations
code-spider intelligence explain <finding-id> # one finding with its evidence
```

`scan --category reachability|cycles|duplication|hotspots|architecture|suppressions`
filters; `--format sarif` emits SARIF 2.1.0 with fingerprints as
`partialFingerprints` for GitHub code scanning.

### Configuration (`.code-spider/config.yaml`)

```yaml
intelligence:
  entrypoints:            # reachability roots (explicit; conventions like
    - src/index.ts        # package.json bin/main, shebangs, and route files
                          # are inferred automatically and marked lower-trust)
  duplication:
    mode: normalized      # strict (default) = exact tokens; normalized
    min-tokens: 40        # collapses string/number literals
  hotspots:
    weights: { complexity: 0.3, centrality: 0.2, churn: 0.2, duplication: 0.15, cycles: 0.15 }
  architecture:
    layers:
      - [app, domain, infra]      # earlier may import later, never reverse
    rules:
      - from: "src/ui/**"
        to: "src/db/**"
        kind: forbid-import
  suppressions:
    - rule: unused-file
      path: "src/legacy/**"
      expires: "2026-12-31"
      owner: platform-team
      reason: migration fallback
```

Suppressions are themselves analyzable: expired or never-matching entries
surface as `stale-suppression` findings instead of silently rotting.

### Honesty model

The suite reports uncertainty rather than rounding it away:

- Files reachable **only through dynamic imports** get low-confidence
  "possibly unused" findings, not silent passes or false warnings.
- Symbol-level rules (`unused-export`, `unused-symbol`) need a `--semantic`
  index and only judge symbols whose references were **actually queried**
  within the LSP budget — "never asked" is not "unreferenced".
- Analyzers fail soft: a crash records a warning and the rest of the scan
  proceeds.

```bash
# Symbol-level depth first:
code-spider index . --semantic
code-spider intelligence unused
code-spider intelligence explain fnd_r12_ab34cd56ef781234   # show the evidence
```

## Architecture

```
src/
├── index.ts                 # CLI parser and command router
├── commands/                # Thin command implementations (doctor, overview, show, etc.)
├── services/
│   ├── doctor.ts            # Health diagnostics and fidelity reporting (core)
│   ├── analyzer-runner.ts
│   ├── semantic-query.ts
│   ├── related.ts
│   ├── exporter.ts
│   └── ...
├── adapters/lsp.ts          # Language Server Protocol bridge
├── language-plugin.ts
├── language-plugin-registry.ts
├── plugins/
│   ├── typescript-javascript-plugin.ts
│   ├── zig-plugin.ts
│   └── registry-legacy-plugin.ts
└── types.ts
```

- **Plugins** select the best available analyzer path per language (LSP preferred, heuristic fallback).
- **Context enrichers** (git, markdown, beads) run alongside structural indexing.
- Database stores runs, nodes (zones/units/symbols), evidence, and relationships.
- All output is designed to be consumed by agents — clear, structured, grounded in real signals.

Hotspots (as reported by the tool itself): `lsp.ts`, `doctor.ts`, their tests, exporter, and related services — exactly where recent development has focused (pluginization, context reporting, semanticRefs fixes).

## Companion Skills

This repository includes:

- `skills/code-spider-claude/SKILL.md` — detailed usage patterns, command sequences, interpretation guidance, and pitfalls for Claude Code workflows.
- `skills/code-spider-codex/SKILL.md` — equivalent guidance for OpenAI Codex.

These skills encode proven investigation recipes that combine structure, git history, markdown context, semantic checks, and doctor validation.

## Development

```bash
bun install
bun test
bun run typecheck      # tsc --noEmit, kept at 0 errors
bun run build          # produces dist/code-spider
```

Key commands during development:
- `code-spider doctor` — validate your changes didn't break analysis health
- `code-spider test/fixtures/...` — use the included TypeScript and cross-file test fixtures

## Supported Languages & Tools

- **TypeScript/JavaScript**: typescript-language-server, builtin heuristics
- **Zig**: zls, zig ast-check
- ripgrep (required for fast structural search)
- Git (for history and co-change analysis)

### Adding a language

Most languages need **no code** — declare them in `config/analyzers.yaml` and
the registry-driven plugin handles the rest (file detection, LSP sessions,
doctor reporting, semantic enrichment):

```yaml
  - id: lisp
    display_name: Lisp
    detect:
      extensions:
        - .lisp
        - .lsp
    analyzers:
      - id: lisp-lsp
        kind: lsp
        tool: lisp-language-server
        command:
          - lisp-language-server
          - --stdio
        capabilities:
          - symbols
          - defs
          - refs
          - diagnostics
        priority: 100
```

Files with the declared extensions are recognized at index time, units carry
the language, and `index --semantic` drives the configured LSP command.
Write a bespoke `LanguagePlugin` implementation only when a language needs
custom heuristics beyond what the registry can express (see
`src/plugins/typescript-javascript-plugin.ts` for the pattern).

## Why code-spider?

Modern AI coding agents frequently hallucinate or miss critical context. This tool provides:
- A doctor that tells you precisely which signals are available and trustworthy
- Grounded evidence (real git commits, nearby docs, co-changing files, beads tasks)
- Navigable zones, flows, and semantic graphs instead of raw file dumps
- Consistent, repeatable investigation workflows captured in companion skills

Built to support deep understanding of complex projects (language VMs, toolchains, GCs, concurrency runtimes — see the included Zig plugin and self-analysis of this repo).

## Roadmap / Active Areas

- Further stabilization of semantic references and context enrichers
  (LSP session reuse to lift the symbol-reference budget)
- Richer beads/work-item integration
- Additional language plugins (especially for Lisp/Scheme ecosystems)
- `tested-by` edge population (orphan-test detection currently uses the
  co-located sibling convention)
- First-class support for investigation sessions

Recent tickets (code-spider-*) have focused on context layer rollout, doctor accuracy, plugin architecture, and atom tagging.

---

**Generated with code-spider itself.**

Run `code-spider doctor` or `code-spider inspect .` to see live analysis of this repository.
