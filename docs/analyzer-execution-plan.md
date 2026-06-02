# Analyzer Execution Extension Plan

## Goal

Extend `code-spider` from registry-driven analyzer selection and reporting into registry-driven analyzer execution across multiple analyzer kinds and capabilities.

Today, the registry is used to:

- define languages and analyzers
- choose LSP analyzers
- report analyzer availability in `doctor`

It is not yet used to:

- run non-LSP analyzers
- execute fallback chains explicitly
- power `defs` and `refs`
- record analyzer execution outcomes in a structured way

## Current State

What exists now:

- YAML analyzer registry
- registry loader and validation
- registry-driven LSP selection
- registry-driven doctor reporting
- regression tests for the registry pipeline

What is still missing:

- execution for `quality` analyzers
- execution policy for analyzer fallback
- capability-specific command routing
- explicit analyzer run recording
- richer mixed-language repo handling

## Desired End State

For any supported repo, `code-spider` should:

1. detect relevant languages in the repo
2. select analyzers from the registry by capability and priority
3. execute the best available analyzer
4. fall back cleanly when the preferred analyzer is unavailable
5. record what ran, what succeeded, and what coverage was achieved
6. expose that behavior through commands like:
   - `index --semantic`
   - `doctor`
   - `defs`
   - `refs`
   - future diagnostics/report commands

## Phase 1: Execution Model

### 1. Define analyzer execution policy

Document the runtime rules for:

- analyzer kind precedence
- capability resolution
- per-language fallback
- repo-level mixed-language behavior
- what to do when multiple analyzers provide the same capability

Recommended baseline:

- choose analyzers by language, capability, and highest priority
- only run analyzers whose required files and executable are present
- if the top analyzer is unavailable, try the next eligible analyzer
- if nothing is available, fall back to structural-only behavior

### 2. Add execution-oriented registry semantics

The current schema is enough to start, but execution may need a few additions later:

- optional `scope`: `repo`, `file`, or `symbol`
- optional `supports_fallback`: boolean
- optional `output`: expected result shape such as `lsp`, `diagnostics`, `none`
- optional `timeout_ms`

Do not add these until the runtime actually needs them.

## Phase 2: Quality Analyzer Execution

### 3. Implement execution of `quality` analyzers

Start with file-scoped analyzers that can emit diagnostics or evidence.

Example targets:

- Zig: `zig ast-check {file}`
- Rust: later, `cargo check` or file-scoped equivalents if practical
- TypeScript: later, `tsc --noEmit` at repo scope if desired

Implementation requirements:

- resolve command templates such as `{file}` and `{repo_root}`
- run the command safely with timeout/error handling
- capture stdout/stderr and exit code
- normalize outputs into:
  - diagnostics
  - evidence
  - analyzer run status

Recommended first milestone:

- support `quality` analyzers that only produce pass/fail + textual diagnostics
- treat text parsing as adapter-specific, not generic magic

### 4. Add analyzer runner abstraction

Introduce an execution layer that dispatches by analyzer kind:

- `lsp` -> existing LSP adapter path
- `quality` -> command runner path
- `heuristic` -> in-process fallback path

This should keep the registry as data and the runtime logic in TypeScript.

## Phase 3: Capability Routing

### 5. Route `defs` and `refs` through registry capabilities

The registry already declares which analyzers claim:

- `defs`
- `refs`

The next step is to replace the current stubs with capability-aware execution:

- resolve the target language or symbol context
- pick the best analyzer that supports the requested capability
- execute it
- normalize output for the CLI

Recommended approach:

- implement one capability at a time
- start with TypeScript/JavaScript if the LSP path is easiest
- keep unsupported capabilities explicit and well messaged

### 6. Extend semantic enrich flow to capability-driven execution

Current enrichment is effectively “get symbols from LSP.”

Longer-term it should become:

- symbols from the best analyzer that supports `symbols`
- diagnostics from analyzers that support `diagnostics`
- refs/defs made available for future commands

## Phase 4: Analyzer Run Recording

### 7. Record analyzer execution results explicitly

Add structured recording for:

- analyzer id
- language
- files processed
- capabilities attempted
- capabilities succeeded
- error or fallback reason
- duration

This may need either:

- new DB tables, or
- additional metadata columns in the existing analyzer/evidence model

Recommended direction:

- add a dedicated analyzer run table later if reporting needs grow
- avoid overloading the current `analyzers` table with execution-instance data

### 8. Improve doctor fidelity using actual run results

Once analyzer execution results are recorded, `doctor` should report:

- configured analyzers
- available analyzers
- analyzers actually used in the last run
- capability coverage achieved in the last run

That is more useful than availability-only reporting.

## Phase 5: Mixed-Language and Repo Detection Improvements

### 9. Improve repo language detection

Current detection is simple:

- file extensions
- manifest presence

Possible improvements:

- language weighting by file count or LOC
- identify a primary language
- distinguish incidental files from core repo languages
- better toolchain inference for mixed repos

Recommended rule:

- keep simple detection for now
- only expand when execution logic needs better prioritization

## Suggested Implementation Order

1. define execution policy
2. add analyzer runner abstraction
3. implement `quality` analyzer execution
4. support first non-LSP fallback path
   - recommended: Zig `zls` -> `zig ast-check`
5. record analyzer execution outcomes
6. route `defs` and `refs` through registry capabilities
7. improve mixed-language prioritization if needed

## Recommended First Target

Use Zig as the first non-LSP execution example.

Why:

- clear motivating use case
- already present in the registry
- demonstrates the value of fallback execution
- helps prove the design is not TypeScript-centric

Minimum Zig milestone:

- if `zls` is available, keep current semantic path
- if `zls` is unavailable but `zig` is available, run `zig ast-check {file}`
- capture failures as diagnostics/evidence
- surface the result in `doctor` and future reports

## Risks

- output normalization for non-LSP tools can get messy if made too generic
- repo-scoped analyzers like `cargo check` or `tsc --noEmit` need careful performance handling
- capability routing for `defs` and `refs` may require more adapter-specific logic than the registry alone can express
- mixed-language repos can produce confusing behavior if analyzer precedence is not clearly defined

## Recommendation

Do not try to implement every analyzer kind and capability at once.

Use the registry to drive one additional execution path first:

- `quality` analyzers
- file-scoped fallback
- Zig as the pilot language

That will validate the model with minimal blast radius before expanding into `defs`, `refs`, and repo-scoped quality tooling.
