# code-spider fix plan

## Goal

Address the review findings that affect correctness, CLI contract accuracy, and output quality without disrupting existing user work in the repo.

## Scope

This plan covers:

- indexing the correct repository database when `index [path]` is used
- preventing SQLite open-time lock failures across concurrent CLI invocations
- excluding tool artifacts and scratch directories from indexing
- making `flows [<node-ref>]` either work as documented or updating the contract
- fixing `children --sort recent`
- implementing or removing the dead `--incremental` flag
- adding test coverage for the affected command paths

This plan does not include new feature work beyond what is needed to make the existing CLI behavior correct and supportable.

## Proposed work order

### 1. Fix database path handling for `index [path]`

Problem:

- `parseArgs()` computes `ctx.dbPath` before the `index` command swaps to a positional target path.
- Running `index /some/repo` from another directory writes the database to the wrong place.

Implementation:

- Derive the effective target repo inside `index-cmd.ts`.
- Recompute the index database path from that target repo instead of reusing `ctx.dbPath`.
- Pass the recomputed database path to both `Indexer.run()` and `SemanticEnricher.run()`.
- Keep `ctx.repoRoot` behavior unchanged for non-index commands.

Validation:

- Run `index` from inside the target repo.
- Run `index /abs/path/to/repo` from a different working directory.
- Confirm `.code-spider/index.db` is created under the target repo in both cases.
- Confirm `overview` works when pointed at that repo with `--repo`.

### 2. Make database open safe under concurrent reads

Problem:

- `openDb()` runs `PRAGMA journal_mode=WAL` on every open.
- Independent CLI commands can fail with `SQLITE_BUSY_RECOVERY`.

Implementation:

- Change database initialization so WAL/schema setup happens only when needed, not on every read path.
- Prefer a small initialization routine that:
  - opens the database
  - enables foreign keys
  - applies schema
  - avoids journal mode mutation on every command startup
- If WAL is still desired, set it only during index creation/update, or guard it so read-only commands do not force a journal transition.
- Add a small retry or friendlier error path only if the underlying locking behavior still needs it after the structural fix.

Validation:

- Run `overview`, `zones`, `flows`, and `investigate show` in parallel against the same DB.
- Confirm they no longer fail during `openDb()`.
- Re-run an index followed by concurrent reads.

### 3. Exclude generated and scratch content from indexing

Problem:

- The index currently includes `.code-spider`, `.claude`, agent worktrees, and other non-source artifacts.
- That pollutes zones, language summaries, and hotspot output.

Implementation:

- Expand ignore rules in `FilesystemAdapter`.
- At minimum exclude:
  - `.code-spider`
  - `.claude`
  - `.nardo`
  - `.omc`
  - SQLite sidecar files like `*.db`, `*.db-wal`, `*.db-shm`, `*.sqlite`, `*.sqlite3`
- Consider supporting configurable ignore patterns later, but start with hard-coded exclusions for known tool artifacts.
- Keep source directories like `src` and normal config files indexable.

Validation:

- Re-index this repo.
- Confirm `overview` no longer shows `.code-spider/index.db-wal` or worktree scratch files as hotspots.
- Confirm zones represent actual project areas instead of agent/tool state.

### 4. Resolve the `flows [<node-ref>]` contract mismatch

Problem:

- Help text advertises an optional node filter.
- The command ignores the positional argument and always returns repo-wide heuristic flows.

Decision needed:

- Option A: implement filtering by node or zone.
- Option B: remove the positional argument from help until filtering exists.

Recommended approach:

- Short term: fix the contract immediately by either implementing a narrow filter or removing the advertised argument.
- If implementing, support at least:
  - `unit:<path>` or exact node key matching
  - `zone:<name>` filtering
  - repo default behavior when omitted

Implementation:

- Update `flows.ts` to parse and pass the filter.
- Update `FlowDetector` to either:
  - scope evidence/node lists to the requested node set, or
  - post-filter detected flows in a way that is predictable and documented.

Validation:

- Compare `flows --json` with and without a node argument.
- Confirm a unit-specific request no longer returns unrelated command/service nodes.

### 5. Fix `children --sort recent`

Problem:

- `children.ts` accepts `recent`.
- `Navigator.getChildren()` maps every non-score sort except `churn` to `loc`.

Implementation:

- Add a real `recent` mapping to the `recency` stat.
- Define the intended order explicitly:
  - if “recent” means newest first, sort by lowest recency value ascending
  - if not, rename the flag to avoid ambiguity
- Update human-readable output if needed so users understand the sort order.

Validation:

- Compare `children zone:src --sort recent --json` and `--sort loc --json`.
- Confirm results differ and that recent files appear first by recency metric.

### 6. Remove or implement `--incremental`

Problem:

- `--incremental` is parsed and forwarded but ignored.

Decision needed:

- Option A: remove it from help and command parsing for now.
- Option B: implement real incremental indexing.

Recommended approach:

- Remove the flag now unless incremental indexing is already close to being built.
- Shipping a fake flag is worse than having no flag.

Implementation if removed:

- Delete it from usage text and `index-cmd.ts`.
- Remove the unused field from `IndexOptions` if nothing else depends on it.

Implementation if kept:

- Define exact incremental semantics first:
  - changed files only
  - manifest refresh behavior
  - stale node cleanup
  - score normalization behavior
- This is materially larger work and should likely be its own issue.

Validation:

- If removed, confirm help text and runtime flags match.
- If implemented, add dedicated tests for changed-file and deleted-file scenarios.

### 7. Add regression tests around the CLI contracts

Problem:

- The repo currently has no tests.
- The issues found are primarily behavioral regressions that TypeScript does not catch.

Implementation:

- Add a lightweight test harness around the CLI and the core services.
- Focus first on high-value regression coverage:
  - `index [path]` stores DB under the target repo
  - concurrent read commands do not fail at DB open
  - generated artifact directories are excluded from indexing
  - `flows <node-ref>` matches the documented behavior
  - `children --sort recent` sorts by recency rather than LOC
  - help text matches actual supported commands/flags

Suggested structure:

- service-level tests for `FilesystemAdapter`, `Navigator`, and DB init behavior
- CLI-level smoke tests for argument handling and command output contracts

## Suggested rollout

### Phase 1: correctness and stability

- fix `index [path]`
- fix DB open locking behavior
- fix ignore rules

### Phase 2: contract cleanup

- fix or de-scope `flows [<node-ref>]`
- fix `children --sort recent`
- remove or implement `--incremental`

### Phase 3: regression protection

- add tests for all corrected behavior

## Risks and notes

- Changing DB initialization touches every command path, so it should be verified before any broader refactor.
- Excluding more paths from indexing may change snapshot-like outputs for existing users; that is expected and desirable here.
- If `flows` filtering is implemented, the behavior should be kept intentionally narrow rather than guessing at a broader semantic scope.
- Incremental indexing should not be started casually unless we are willing to define deletion and score recomputation semantics clearly.

## Recommended next step

Proceed with Phase 1 first. Those fixes address real failures and misleading output, and they reduce noise before deciding whether the CLI contract fixes should be implemented or trimmed back.
