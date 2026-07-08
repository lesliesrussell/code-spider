# Run Lifecycle: Capability-Resolved Reads + Prune

Bead: code-spider-ebz · 2026-07-08

## Problem

Every `index` inserts a complete new snapshot (nodes, evidence, stats) under a
new `run_id`. Expensive capabilities — symbols (`--semantic`) and embeddings
(`--embed`) — attach to whichever run produced them. Two failure modes follow:

1. **Capability stranding.** A follow-up run without a flag becomes the
   latest run with none of that capability's rows. Readers keyed to
   "latest run" silently go empty (symbols: fixed for atoms/defs/refs by
   code-spider-ag4) or hard-error (`find` refuses when the latest run has no
   embeddings, even though an older run has usable vectors).
2. **Unbounded growth.** Nothing deletes old runs. Dogfooding produced a
   24 MB index for a 200-file repo in ~6 weeks.

## Considered: layered runs (rejected)

A run could record a `parent_run_id` and inherit unchanged rows. Rejected:
node ids are per-run, so inheritance needs either cross-run id mapping on
every read (complexity tax on all queries) or copy-forward writes (write
amplification — the current `--incremental` carry-forward already does this
for symbols/embeddings and is the right tool when the flag is passed).
Capability-resolved reads achieve the useful part — never silently losing
data that exists — with two small queries at read time.

## Design

### 1. Capability-resolved run selection

`Navigator.resolveRunFor(db, repoRoot, capability)` where capability ∈
`'symbols' | 'embeddings'`:

- latest completed run has rows in the capability's table → use it
- otherwise → newest completed run that does, reporting `fallbackFrom`
  (the skipped latest run) so commands surface a one-line stderr note
- no run has the capability → latest run (commands keep their existing
  empty/error paths)

`resolveSemanticRunId` (code-spider-ag4) becomes `resolveRunFor('symbols')`.
`find` adopts `resolveRunFor('embeddings')`. Reads never mix runs: fallback
selects one older run wholesale, so node ids stay internally consistent;
node *keys* (`unit:path`) are stable across runs, which is what output uses.

`related --kind meaning` is intentionally left on the latest run: its other
signals (git, docs, topology) must come from the latest snapshot and mixing
two runs in one command would be worse than a missing meaning signal.

### 2. `prune` command

`code-spider prune [--keep <n>] [--dry-run]` (default keep = 3).

Protected runs (never deleted):
- the newest completed run
- the newest run with symbols and the newest with embeddings (the live
  fallback targets)
- any run referenced by an investigation (saved threads must stay
  evidence-backed)
- the `--keep` newest runs

Everything else is deleted from all 13 run-scoped tables (symbol_edges,
diagnostics, symbols, embeddings, evidence, findings, stats, edges,
analyzer_runs, token_events, analyzers, nodes, runs), then `VACUUM`
reclaims the file. `--dry-run` prints the plan without touching data.

### Non-goals

- No schema change; the "manifest" is two EXISTS probes, not a table.
- No automatic prune on index; growth is visible (`doctor perf`) and prune
  is one command. Revisit if users are surprised in practice.
- Chunk-level embeddings (code-spider-5ns) builds on this: prune bounds the
  table it will multiply.
