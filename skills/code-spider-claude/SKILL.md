---
name: code-spider-claude
description: Use when Claude Code should work through a repository with code-spider, especially for investigation-style exploration, evidence-backed reading plans, static-analysis audits (dead code, cycles, duplication, hotspots, architecture rules via intelligence scan), or command recipes that combine repo structure, git history, markdown context, and semantic checks.
---

# Code-Spider For Claude Code

Use `code-spider` to build an evidence-backed investigation path through a repository. Start broad, then narrow to files, symbols, and contextual evidence.

## Recommended investigation sequence

### 1. Non-destructive first pass

```bash
code-spider inspect /path/to/repo
```

Use this to capture:
- languages
- top zones
- hotspot files
- whether the repo looks structurally healthy or polluted by generated files

### 2. Stable working DB for repeated investigation

```bash
code-spider index /path/to/repo --db /tmp/repo-code-spider.db
```

Then keep using the same DB:

```bash
code-spider overview --repo /path/to/repo --db /tmp/repo-code-spider.db
code-spider show --repo /path/to/repo --db /tmp/repo-code-spider.db repo:.
code-spider children --repo /path/to/repo --db /tmp/repo-code-spider.db zone:src
```

### 3. Build a reading path

For an important file:

```bash
code-spider show --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
code-spider related --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
```

Interpret the `show` sections as:
- `Stats`: churn/LOC/score metrics for the node
- `Git Context`: recent commit-message rationale
- `Docs Context`: markdown sections that explicitly document the file
- `Tracked Issues`: issue/task context when Beads data is usable
- `Evidence`: direct supporting signals for the node

Prefer `--json` when you intend to parse output programmatically — every
command supports it, and field names are stabler than human headings.

### 3b. Semantic search when ollama is available

```bash
code-spider index /path/to/repo --db /tmp/repo.db --embed
code-spider find "where is retry logic handled" --repo /path/to/repo --db /tmp/repo.db
code-spider related --repo /path/to/repo --db /tmp/repo.db unit:src/main.ts --kind meaning
```

`--embed` requires a local ollama with `nomic-embed-text` (doctor reports
availability under the `ollama` check). `find` ranks units by meaning — no
symbol names needed; `related --kind meaning` surfaces conceptual neighbors
beyond shared symbols. Caveat: one vector per file — code buried mid-file in
very long units may rank lower than expected. Re-run with `--incremental` to
re-embed only changed files.

### 4. Add semantic depth when available

```bash
code-spider index /path/to/repo --db /tmp/repo-code-spider.db --semantic
code-spider doctor --repo /path/to/repo --db /tmp/repo-code-spider.db
code-spider defs --repo /path/to/repo --db /tmp/repo-code-spider.db SymbolName
code-spider refs --repo /path/to/repo --db /tmp/repo-code-spider.db SymbolName
code-spider atoms --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
```

Use `doctor` to decide whether semantic results are trustworthy. Scopes
narrow the report: `doctor semantic` (analyzer readiness + coverage),
`doctor repo` (tooling, database, enrichers), `doctor perf` (size/db).

- `Selected plugins` shows which built-in plugin path is active per detected language
- `Selected analyzers` shows which concrete tools that plugin can use in the current environment
- Semantic fidelity fields (`symbolNavigation`, `semanticRefs`, `diagnostics`)
  are tri-state, not boolean:
  - `'pass'` — exercised and succeeded in the last run; trust it
  - `'warn'` — analyzer available but the last run never exercised it
    (e.g. structural-only index). NOT verified — run `index --semantic` first
  - `'fail'` — exercised and produced nothing, or no analyzer available
- In `--json`, read `recommendations`: it lists the concrete next commands
  (e.g. "run: code-spider index --semantic") so you don't have to interpret
  fidelity states yourself

Semantic enrichment caps at 100 files by default; the CLI prints a note when
files were skipped. Use `index --semantic --max-files <n|all>` to raise or
lift the cap for full-repo enrichment.

When something silently degrades, re-run any command with
`CODE_SPIDER_DEBUG=1` to surface suppressed errors on stderr.

## Example workflows

### Explain how a system is organized

```bash
code-spider overview --repo /path/to/repo --db /tmp/repo.db
code-spider zones --repo /path/to/repo --db /tmp/repo.db
code-spider children --repo /path/to/repo --db /tmp/repo.db zone:src --sort score
```

Summarize:
- major code zones
- top hotspot files
- likely entrypoints

### Investigate one subsystem

```bash
code-spider show --repo /path/to/repo --db /tmp/repo.db unit:src/runtime/eval.zig
code-spider related --repo /path/to/repo --db /tmp/repo.db unit:src/runtime/eval.zig
code-spider flows --repo /path/to/repo --db /tmp/repo.db unit:src/runtime/eval.zig
```

Use the output to explain:
- what changed recently
- what is documented nearby
- what files tend to move together
- what other units are probably part of the same subsystem

### Audit a repo for dead code, cycles, and duplication

```bash
code-spider intelligence scan --repo /path/to/repo --db /tmp/repo.db
code-spider intelligence scan --repo /path/to/repo --db /tmp/repo.db --format md   # report form
code-spider intelligence explain <finding-id> --repo /path/to/repo --db /tmp/repo.db
```

Findings carry stable fingerprints (they survive line drift — quote them when
tracking an issue across runs), a confidence level, and evidence via
`explain`. Subcommands scope one family: `cycles`, `unused`, `dupes`,
`hotspots`, `arch`.

Interpretation rules:
- `confidence: low` on `unused-file` means "only reachable through dynamic
  imports" — report it as *possibly* unused, never as dead.
- `unused` needs entrypoints: set `intelligence.entrypoints` in
  `.code-spider/config.yaml` and re-index. Conventions (package.json
  bin/main, shebang scripts, route files) are inferred automatically.
- `unused-export`/`unused-symbol` only appear after `index --semantic` and
  only for symbols whose references were actually LSP-queried — absence of a
  finding is not proof of use.
- Suppress accepted findings in config (`intelligence.suppressions`) rather
  than ignoring them; expired or dead suppressions surface themselves as
  `stale-suppression` findings.

### Check whether semantic mode is worth it

```bash
code-spider doctor --repo /path/to/repo --db /tmp/repo.db
```

If the selected plugin path is unavailable, degraded, or last-run coverage is poor, stay in structural-plus-context mode and say so clearly.

## Ignore config

Common cache/self-referential dirs (`.git`, `node_modules`, `dist`,
`.code-spider`, `.claude`, `.omc`, `.zig-cache`, `zig-out`, …) are ignored by
default across indexing, doctor, LSP collection, and flow detection. For
project-specific noise, create or recommend `.code-spider/config.yaml`:

```yaml
ignore:
  dirs:
    - generated
    - bench-results
  globs:
    - "*.db"
    - "*.generated.ts"
```

For non-Node ecosystems, a `flows:` section extends flow detection with
project-specific deps and rg patterns (`route_deps`, `route_patterns`,
`queue_deps`, `queue_patterns`, `event_deps`, `event_patterns`,
`cli_patterns`). Each category adds at most one strong signal — recommend
this when `flows` is empty on a Python/Rust/Lisp repo.

## Guidance for Claude-style investigation

- Prefer `inspect` before `index`.
- Prefer explicit `--db /tmp/...` during exploration.
- Use `show` and `related` together; one gives evidence, the other gives the next reading targets.
- Treat git and markdown as context, not truth.
- Treat Beads as useful only when issue text is explicit and current.
- When semantic analyzers are installed but ineffective, say that directly instead of pretending the output is richer than it is.
