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
  - Investigation management and report export
- **Context layers**:
  - Git history, co-changes, commit rationale
  - Markdown sections and nearby documentation
  - Beads (issues, tasks, dependencies)
- **Language plugins** — first-class support for TypeScript/JavaScript (tsserver LSP + heuristic) and Zig (zls + zig-ast-check). Extensible registry.
- **Hotspot & flow analysis** — identifies active areas and logical subsystems

Perfect companion for the `code-spider-claude` and `code-spider-codex` skills included in this repository.

## Quick Start

```bash
# Install (Bun)
bun install

# Build standalone binary (optional)
bun run build

# Basic investigation flow
code-spider inspect .                    # Non-destructive first pass
code-spider index . --db /tmp/myrepo.db  # Build persistent index
code-spider doctor --db /tmp/myrepo.db   # Check what is trustworthy
code-spider overview --db /tmp/myrepo.db
code-spider zones --db /tmp/myrepo.db --sort score
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

Extending to new languages (Lisp, Python, Rust, etc.) is done by adding plugins that implement the `LanguagePlugin` interface and registering analyzer capabilities.

## Why code-spider?

Modern AI coding agents frequently hallucinate or miss critical context. This tool provides:
- A doctor that tells you precisely which signals are available and trustworthy
- Grounded evidence (real git commits, nearby docs, co-changing files, beads tasks)
- Navigable zones, flows, and semantic graphs instead of raw file dumps
- Consistent, repeatable investigation workflows captured in companion skills

Built to support deep understanding of complex projects (language VMs, toolchains, GCs, concurrency runtimes — see the included Zig plugin and self-analysis of this repo).

## Roadmap / Active Areas

- Further stabilization of semantic references and context enrichers
- Richer beads/work-item integration
- Additional language plugins (especially for Lisp/Scheme ecosystems)
- Improved report export formats for agents
- First-class support for investigation sessions

Recent tickets (code-spider-*) have focused on context layer rollout, doctor accuracy, plugin architecture, and atom tagging.

---

**Generated with code-spider itself.**

Run `code-spider doctor` or `code-spider inspect .` to see live analysis of this repository.
