# Token Savings — Design

## Goal

After an investigation completes, report how many cloud tokens code-spider saved
by doing the heavy ingestion locally and sending only a distilled result to the
cloud AI. The number is a **confidence booster, an estimate — not an audit**.
Directional honesty (±15%) is the bar, not precision.

The core identity:

```
saved = ingested − emitted
```

- **Ingested** — tokens of source/evidence that producing an answer *rested on*
  (what the cloud would otherwise have had to read).
- **Emitted** — tokens actually sent to the cloud (the stdout the cloud consumed).

Every ingested token is a token that *would* have entered the cloud context if
code-spider weren't funneling, so the delta is a real avoided cost.

## Scope of the headline number

Two numbers, each honest about what it represents:

1. **Per-investigation headline** — `Σ(ingested − emitted)` over the commands run
   while an investigation was active. Answers "*this* investigation saved you X."
2. **Lifetime corpus total** — real source tokens code-spider digested at index
   time. Answers "code-spider has already absorbed Y tokens of this repo so the
   cloud never had to." Amortized across all investigations, not one.

A third, optional **naive ceiling** is shown as flavor: "if the cloud had read the
whole repo to answer this: ~Z tokens" — the corpus total presented as an upper
bound for context. It is clearly labeled as a ceiling, not the measured saving.

## Counterfactual model

The cloud (Claude) drives code-spider by running CLI commands and reading their
stdout. So:

- **Emitted** = cumulative stdout of every code-spider command in the thread —
  literally what lands in Claude's context.
- **Ingested** = what each command's answer was *derived from* under the hood.

Per command: `saved = ingested_by_command − stdout_tokens`. Summed over the
investigation = headline.

Important subtlety: real file reads happen at **index time** (the repo is scanned
once); at **investigation time** commands read from SQLite, not source. So we
attribute ingestion by **provenance**, not by literal disk reads at query time:
each command's ingested value is the stored token-size of the nodes/files/evidence
its answer drew from. That measures "what the cloud would have had to read to
reach the same answer," which is exactly the counterfactual.

## Components

### 1. `TokenCounter` interface

```
interface TokenCounter {
  count(text: string, kind?: 'code' | 'prose' | 'diff'): number
}
```

Default `RatioTokenCounter`: `chars / ratio`, with per-kind ratios
(code ≈ 3.5, prose ≈ 4, diff/git ≈ 4; configurable). Zero dependencies, instant.
Pluggable so a real BPE tokenizer (tiktoken `o200k`, etc.) can drop in later
without touching accounting code. The savings number is inherently an estimate, so
the ratio is sufficient for v1.

### 2. `TokenLedger` service

Appends token events scoped to the **active investigation**. While an
investigation is active, each code-spider command logs one row:
`{ run_id, investigation_id, command, ingested, emitted, ts }`.

### 3. Provenance hook (ingested)

Commands already produce a result set of nodes/evidence (the same data behind
`--json`). The dispatch layer sums those nodes' stored token-size to get
`ingested`. Node token-size is computed **once at index time** from each node's
source bytes via the `TokenCounter`, so it is free at query time.

- `show unit:auth.ts` → token-size of that file.
- `children` / `related` / `find` → Σ token-size of returned nodes.
- `intelligence scan` → Σ token-size of analyzed files.

For commands whose answer is hard to attribute to specific nodes, ingested falls
back to 0 (under-counts savings rather than inventing them — conservative).

### 4. Emitted hook

The dispatch layer tokenizes the command's final stdout string immediately before
printing and records it as `emitted`. That is exactly what the cloud consumed.

### 5. Corpus meter (index time)

While indexing, sum real source tokens digested into a single lifetime number,
stored on the `runs` row as `corpus_ingested_tokens`.

## Active-investigation model

Savings accrue **only for commands run while an investigation is started**:

```
investigate start          → marks investigation N active (persisted to state)
<any cs command>           → dispatch wraps it:
                               ingested = Σ tokens of nodes/files in result
                               emitted  = count(stdout)
                               append token_event(investigation=N, …)
investigate show N         → Σ rows → savings footer
```

Commands run ad-hoc with **no active investigation do not count** toward a thread.
This keeps attribution clean and avoids polluting a thread with unrelated work.

## Data flow

```
investigate start  → set active investigation = N (state file)
any cs command     → [dispatch middleware]
                       result   = command()
                       ingested = Σ node.tokens for nodes in result
                       emitted  = tokenCounter.count(renderedStdout)
                       if active investigation: ledger.append(N, cmd, ingested, emitted)
                       print stdout
investigate show N → rows = ledger.byInvestigation(N)
                     saved = Σ(ingested) − Σ(emitted)
                     render: "Saved ~X tokens (ingested ~A, sent ~B). Naive ceiling ~Z."
```

## Schema changes

- Node stats: add `tokens INTEGER` (filled at index time, from source bytes).
- New table:
  ```sql
  CREATE TABLE token_events (
    id              INTEGER PRIMARY KEY,
    run_id          INTEGER NOT NULL,
    investigation_id INTEGER NOT NULL,
    command         TEXT NOT NULL,
    ingested        INTEGER NOT NULL,
    emitted         INTEGER NOT NULL,
    ts              INTEGER NOT NULL
  );
  ```
- `runs` row: add `corpus_ingested_tokens INTEGER`.

## Surfaces

- `investigate show <id>` → token-savings footer.
- `export report` → "Token Savings" section (md + json).
- `overview` / `doctor` → lifetime corpus total.
- All respect `--json` (machine-readable savings object:
  `{ saved, ingested, emitted, naiveCeiling, corpusTotal }`).

## YAGNI — explicitly not doing

- No live Claude tokenizer round-trips (would defeat the purpose and cost tokens).
- No per-byte adapter interception at query time (query-time reads are SQLite, not
  source — they misrepresent the counterfactual).
- No attempt at sub-15% accuracy.
- No tracking of commands run outside an active investigation.
- No retroactive attribution of index-time reads to specific investigations beyond
  the provenance sum.

## Testing

- `RatioTokenCounter` — ratio math, per-kind selection, empty/large inputs.
- `TokenLedger` — append, sum by investigation, isolation between investigations.
- Provenance sum — given a result set of nodes with known token-size, ingested is
  correct; unattributable commands yield 0.
- Emitted — stdout string tokenized and recorded.
- Active-investigation gating — no active investigation ⇒ no event recorded.
- Integration — `investigate start` → a few commands → `show` reports a plausible
  positive saving; `export report` includes the section; `--json` shape is stable.
