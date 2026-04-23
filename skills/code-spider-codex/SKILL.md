---
name: code-spider-codex
description: Use when Codex should inspect or investigate a repository with code-spider, especially for fast repo triage, hotspot discovery, semantic lookups, or curated context from markdown and git. Prefer this skill when the user wants command workflows, non-destructive inspection, or examples of how to use code-spider effectively from Codex.
---

# Code-Spider For Codex

Use `code-spider` as a local repo reconnaissance tool. Default to non-destructive inspection first, then move to persistent indexing only if the user needs repeated queries.

## Default workflow

1. For a quick look without writing inside the target repo:

```bash
code-spider inspect /path/to/repo
```

2. If the user will keep querying the same repo, index it with an explicit DB when you want to avoid writing into the target repo:

```bash
code-spider index /path/to/repo --db /tmp/repo-code-spider.db
```

3. Query the indexed repo:

```bash
code-spider overview --repo /path/to/repo --db /tmp/repo-code-spider.db
code-spider zones --repo /path/to/repo --db /tmp/repo-code-spider.db
code-spider show --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
code-spider related --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
code-spider doctor --repo /path/to/repo --db /tmp/repo-code-spider.db
```

## When to use which command

- `inspect`: one-off, non-destructive overview
- `overview`: repo shape, languages, zones, hotspot files
- `zones`: top-level code areas
- `show`: details for one repo/zone/unit node, including git and markdown context when available
- `children`: top files in a zone
- `related`: nearby files based on symbols, flows, markdown, git co-change, and tracked work
- `defs`, `refs`, `atoms`: semantic navigation when the selected language plugin and its analyzers support it
- `doctor`: which plugins and analyzers are active for the repo and what the last semantic run actually achieved

## High-signal workflows

### 1. Triage an unfamiliar repo

```bash
code-spider inspect /path/to/repo
code-spider index /path/to/repo --db /tmp/repo.db
code-spider overview --repo /path/to/repo --db /tmp/repo.db
code-spider children --repo /path/to/repo --db /tmp/repo.db zone:src --sort recent
```

Use this to answer:
- where the real code lives
- which files are hot or central
- whether the repo is dominated by noise or source

### 2. Start reading from a central file

```bash
code-spider show --repo /path/to/repo --db /tmp/repo.db unit:src/main.ts
code-spider related --repo /path/to/repo --db /tmp/repo.db unit:src/main.ts
```

Look for:
- git rationale in `History`
- markdown narrative in `Context`
- tracked work in `Work`
- related files with explicit reasons

### 3. Run a semantic pass

```bash
code-spider index /path/to/repo --db /tmp/repo.db --semantic
code-spider doctor --repo /path/to/repo --db /tmp/repo.db
code-spider defs --repo /path/to/repo --db /tmp/repo.db SymbolName
code-spider refs --repo /path/to/repo --db /tmp/repo.db SymbolName
code-spider atoms --repo /path/to/repo --db /tmp/repo.db unit:src/file.ts
```

Read `doctor` as two layers:
- `Selected plugins`: which built-in plugin path is active per detected language
- `Selected analyzers`: which concrete tools that plugin can use in the current environment

If `doctor` shows `symbolNavigation: false` or `semanticRefs: false`, explain that the selected plugin path is unavailable, degraded, or returned no results.

## Config and hygiene

The target repo can include `.code-spider/config.yaml` to suppress generated or scratch content:

```yaml
ignore:
  dirs:
    - .code-spider
    - .claude
    - .zig-cache
    - zig-out
  globs:
    - "*.db"
    - "*.db-wal"
    - "*.db-shm"
```

Prefer `--db /tmp/...` when you want to keep the target repo untouched.

## Interpretation rules

- Code is the source of truth for what exists now.
- Git explains what changed and often why.
- Markdown explains project narrative and rationale.
- Beads only helps if the repo has meaningful issue text and explicit file or node refs.

Do not treat docs or issue text as equal to code truth.

## Response pattern for Codex

When using `code-spider`, summarize:
- the repo shape
- the top files or zones worth reading
- the strongest reasons from `related` or `show`
- semantic limitations when analyzers are missing or unproductive

Prefer exact command examples the user can reuse.
