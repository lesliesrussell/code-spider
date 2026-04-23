---
name: code-spider-claude
description: Use when Claude Code should work through a repository with code-spider, especially for investigation-style exploration, evidence-backed reading plans, or command recipes that combine repo structure, git history, markdown context, and semantic checks.
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

Interpret the sections as:
- `History`: recent commit-message rationale
- `Context`: markdown sections that explicitly document the file
- `Work`: issue/task context when Beads data is usable
- `Evidence`: direct supporting signals for the node

### 4. Add semantic depth when available

```bash
code-spider index /path/to/repo --db /tmp/repo-code-spider.db --semantic
code-spider doctor --repo /path/to/repo --db /tmp/repo-code-spider.db
code-spider defs --repo /path/to/repo --db /tmp/repo-code-spider.db SymbolName
code-spider refs --repo /path/to/repo --db /tmp/repo-code-spider.db SymbolName
code-spider atoms --repo /path/to/repo --db /tmp/repo-code-spider.db unit:src/main.ts
```

Use `doctor` to decide whether semantic results are trustworthy:
- `Selected plugins` shows which built-in plugin path is active per detected language
- `Selected analyzers` shows which concrete tools that plugin can use in the current environment
- `symbolNavigation: true` means symbol extraction succeeded in the last run
- `semanticRefs: true` means references are usable
- `diagnostics: true` means analyzers produced diagnostic coverage

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

### Check whether semantic mode is worth it

```bash
code-spider doctor --repo /path/to/repo --db /tmp/repo.db
```

If the selected plugin path is unavailable, degraded, or last-run coverage is poor, stay in structural-plus-context mode and say so clearly.

## Ignore config

If output is noisy, create or recommend `.code-spider/config.yaml`:

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
```

## Guidance for Claude-style investigation

- Prefer `inspect` before `index`.
- Prefer explicit `--db /tmp/...` during exploration.
- Use `show` and `related` together; one gives evidence, the other gives the next reading targets.
- Treat git and markdown as context, not truth.
- Treat Beads as useful only when issue text is explicit and current.
- When semantic analyzers are installed but ineffective, say that directly instead of pretending the output is richer than it is.
