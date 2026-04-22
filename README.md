# code-spider

`code-spider` is a local CLI for repository reconnaissance.

It indexes a repo into SQLite, then gives you a fast structural and semantic map:
- top-level zones
- hotspot files
- language and manifest detection
- related files
- definitions and references
- atom-level symbol listings inside a file
- analyzer coverage reporting through `doctor`

## Install

Global install with Bun:

```bash
bun install -g github:leslierussell/code-spider
```

For local development, link the current checkout as a global command:

```bash
bun link
```

After either install path:

```bash
code-spider --help
code-spider doctor
```

## Development

Install dependencies:

```bash
bun install
```

Run directly from the checkout:

```bash
bun run src/index.ts --help
bun run src/index.ts index .
```

## Core Workflow

Use `inspect` when you want a quick, non-destructive pass over a repo:

```bash
code-spider inspect /path/to/repo
```

`inspect` uses a temporary database by default, so it does not leave `.code-spider/index.db` inside the target repo.

Use `index` when you want a persistent local index for repeated exploration:

```bash
code-spider index /path/to/repo
```

Then query it:

```bash
code-spider --repo /path/to/repo overview
code-spider --repo /path/to/repo zones
code-spider --repo /path/to/repo show repo:.
code-spider --repo /path/to/repo children zone:src
code-spider --repo /path/to/repo related unit:src/main.ts
code-spider --repo /path/to/repo defs ExampleService
code-spider --repo /path/to/repo refs ExampleService
code-spider --repo /path/to/repo atoms unit:src/main.ts
code-spider --repo /path/to/repo doctor
```

If you do not want the database inside the repo, override it:

```bash
code-spider index /path/to/repo --db /tmp/my-repo.db
code-spider --repo /path/to/repo --db /tmp/my-repo.db overview
```

## Command Guide

Quick structural exploration:

```bash
code-spider overview
code-spider zones
code-spider show repo:.
code-spider children zone:src
code-spider related unit:src/index.ts
code-spider flows
```

Semantic exploration:

```bash
code-spider index . --semantic
code-spider defs SemanticEnricher
code-spider refs SemanticEnricher
code-spider atoms unit:src/services/semantic-enricher.ts
code-spider doctor
```

Investigation and reporting:

```bash
code-spider investigate
code-spider investigate start "How does indexing work?"
code-spider investigate show 1
code-spider export report repo:.
```

## Data and Config

Default locations inside the target repo:
- index database: `.code-spider/index.db`
- ignore config: `.code-spider/config.yaml`

Example ignore config:

```yaml
ignore:
  dirs:
    - .code-spider
    - .claude
    - .nardo
    - .omc
    - .zig-cache
    - zig-out
  globs:
    - "*.db"
    - "*.db-wal"
    - "*.db-shm"
    - "*.sqlite"
    - "*.sqlite3"
```

`ignore.dirs` excludes matching directories from indexing.

`ignore.globs` excludes matching files by pattern.

The built-in baseline also ignores obvious junk like `.git`, `node_modules`, and `.code-spider`.

## What It Is Good For

Today, `code-spider` is strongest as a local repo triage and exploration tool.

It is useful for:
- finding where real code lives in an unfamiliar repo
- surfacing hot or central files before making changes
- seeing whether a repo is mostly source or mostly generated noise
- getting a lightweight semantic map without opening an IDE
- exporting a compact report for another human or agent

It is not yet a full replacement for IDE-grade cross-language code intelligence.

## Semantic Coverage

Semantic behavior is capability-based, not all-or-nothing.

The current capabilities are:
- `symbols`
- `defs`
- `refs`
- `diagnostics`

Coverage depends on:
- the repo language
- which analyzers are configured in the shipped YAML registry
- which tools are actually installed on the machine
- what succeeded in the latest semantic run

Use `doctor` to see both:
- selected analyzers from the registry
- last-run analyzer coverage from `analyzer_runs`

Example:

```bash
code-spider index . --semantic
code-spider doctor
```

Important details:
- `defs` uses indexed symbols from the latest run
- `refs` uses analyzer-backed references when available and falls back to indexed symbol locations
- `atoms` lists indexed symbols inside a unit
- `doctor` reports actual last-run coverage when semantic indexing has been run

If you have not run semantic indexing yet, `doctor` falls back to showing what analyzers are available rather than what actually ran.

## Current Limitations

Some commands are still heuristic or partial:
- `related` is currently a scored neighbor query based on shared symbols, zone proximity, and flow membership
- `atoms` depends on the quality of the underlying document symbols
- diagnostics coverage is real now, but still depends heavily on installed analyzers
- references are strongest for languages with a working LSP path

The CLI is installed through Bun. It is not a plain Node/npm CLI yet because the runtime still depends on Bun APIs.
