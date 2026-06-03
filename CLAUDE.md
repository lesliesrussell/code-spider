# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Issue Tracking

This project uses **bd (beads)** for issue tracking. Run `bd prime` for full workflow context.

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

**Rules:** Use `bd` for ALL task tracking. Do NOT use TodoWrite, TaskCreate, or markdown TODO lists. Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files.

## Session Completion

Work is NOT complete until `git push` succeeds.

```bash
git pull --rebase
bd dolt push
git push
git status  # MUST show "up to date with origin"
```

## Build & Test

Bun/TypeScript project. Once `src/` exists:

```bash
bun install          # Install dependencies
bun run build        # Compile
bun test             # Run all tests
bun test <file>      # Run single test file
bun run src/index.ts # Run CLI directly
```

The CLI entry point will be `src/index.ts`. The compiled binary is `code-spider`.

## Architecture

Code-Spider is a **pre-implementation** project. All design lives in `code-spider-prd-spec2.md` (primary technical spec). Architecture follows four layers:

### Layer 1 — CLI Shell
Parses commands, handles `--json` output mode, routes to services. Entry: `src/index.ts`.

### Layer 2 — Orchestration Services
Coordinate scans, scoring, summaries, navigation:
- `Indexer` — drives full/incremental scans
- `AnalyzerRegistry` — detects and dispatches available analyzers
- `Navigator` — traversal across the knowledge graph
- `Ranker` — scores nodes by churn, LOC, fan-in/out
- `Summarizer` — generates evidence-backed explanations
- `DoctorService` — environment and capability health checks
- `InvestigationService` — manages saved inquiry threads
- `Exporter` — report generation (md/json)

### Layer 3 — Adapters
Normalize output from external tools: `GitAdapter`, `RipgrepAdapter`, `FilesystemAdapter`, `LspAdapter`, `LinterAdapter`, `LineCountAdapter`.

### Layer 4 — Persistence
SQLite stores all intelligence locally. Key tables: `runs`, `nodes`, `edges`, `evidence`, `stats`, `analyzers`, `symbols`, `symbol_edges`, `diagnostics`, `investigations`. Full schema in `code-spider-prd-spec2.md` §Data model.

## Information Model

Five-layer hierarchy: **Repo → Zone → Flow → Unit → Atom**. Lateral edge kinds: calls, references, imports, extends/implements, contains, defined-in, tested-by, changed-with, configures, emits/consumes-event, routes-to.

Node references use `kind:key` format: `repo:.`, `zone:backend`, `unit:src/auth/service.ts`, `atom:AuthService.authenticate`, `flow:login`.

## Analyzer Plugin Contract

Each analyzer declares: name, kind (structural | heuristic | semantic | quality), supported languages, detection logic, prerequisites, and output normalization strategy. Analyzers must fail soft — a crash or timeout records the failure and degrades gracefully without poisoning the run.

## Command Tree

```
code-spider
  doctor [semantic|repo|perf]
  inspect [path]
  index [path] [--semantic]
  overview
  zones [--limit <n>]
  show <node-ref>
  children <node-ref> [--limit <n>] [--sort score|churn|loc|recent]
  related <node-ref> [--limit <n>]
  flows [<node-ref>] [--limit <n>]
  refs <symbol-or-node>
  defs <symbol-or-node>
  atoms <unit-ref>
  investigate [start|add|note|show]
  export report <node-ref|investigation-id> [--format md|json]
```

Every command supports `--json` (machine-readable output), `--repo <path>`, and `--db <path>`.

Planned per PRD but **not yet implemented** (do not document as working):
`index --incremental` (code-spider-oun), `overview --run <id>`,
`zones --kind`, `show --semantic|--evidence`, `related --kind <edge-kind>`.

## Key Design Constraints

- **Graceful degradation**: structural-only mode must work without LSP or any linter
- **Evidence over assertion**: every summary must expose supporting evidence on request
- **Fail soft**: analyzer failures record the event, degrade capability, never crash the session
- **Local-first**: no remote services; SQLite is the single source of truth
- **Staged indexing**: broad inventory first, semantic enrichment follows
