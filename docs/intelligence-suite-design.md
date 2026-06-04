# Intelligence Analyzer Suite — Design

<!-- code-spider-qsb -->

Status: design accepted, phased delivery below.
Origin: adapted from a Fallow-inspired "intelligence plugin" spec, rewritten to fit
code-spider's actual architecture. Fallow references: unused files/exports/deps,
circular dependencies, duplication modes, complexity hotspots, architecture issues,
structured CI/agent output.

## Decision: not a plugin

The original spec proposed a standalone plugin (`CodeSpiderPlugin` contract, its own
`IntelligenceGraph` IR, its own config file). Rejected. Code-spider already has:

- A graph IR: `nodes`/`edges` tables, 8 node kinds, 17 edge kinds (`src/types.ts`)
- An evidence model: `evidence` + `diagnostics` tables, evidence-per-claim as a core constraint
- An analyzer registry: `config/analyzers.yaml` (embedded in binary), kinds
  `structural | heuristic | semantic | quality`
- Services that already do partial intelligence work: risk scoring in
  `src/services/exporter.ts` (`getRiskAssessment`), flow inference in `FlowDetector`
- Config: `.code-spider/config.yaml`
- `--json` on every command

A parallel plugin contract and parallel IR would duplicate all of this for no gain.
Instead the five analysis families land as **new in-process analyzers + services**
over the existing SQLite graph, surfaced through a new `intelligence` command family.

## What's genuinely new

| Capability | Status today | Work |
|---|---|---|
| Cycle/SCC detection | none | Tarjan over `edges`; new findings |
| Entrypoints | not modeled | new node metadata + config + inference |
| Reachability/unused | ref chains exist, no solver | BFS from entrypoints, set-difference |
| Duplication | none | token-window hashing, 2 modes |
| Hotspot scoring | partial (`getRiskAssessment`) | fold in cycle membership, duplication, centrality |
| Architecture rules | heuristic only (`FlowDetector`) | declarative rules in config |
| Findings schema | none (diagnostics only) | new `findings` table, stable fingerprints |
| SARIF/markdown findings export | md/json node export only | Exporter formats |
| Edge confidence | not in schema | migration: `confidence REAL` on `edges` |

## Schema extensions

```sql
-- migration: edge confidence (default 1.0 = certain)
ALTER TABLE edges ADD COLUMN confidence REAL NOT NULL DEFAULT 1.0;

CREATE TABLE findings (
  id TEXT PRIMARY KEY,            -- fnd_<ulid>
  run_id INTEGER NOT NULL REFERENCES runs(id),
  rule_id TEXT NOT NULL,          -- stable once released
  category TEXT NOT NULL,         -- reachability|cycles|duplication|hotspots|architecture
  severity TEXT NOT NULL,         -- info|warning|error
  confidence TEXT NOT NULL,       -- low|medium|high
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  fingerprint TEXT NOT NULL,      -- stable across runs; CI/agent tracking key
  node_key TEXT,                  -- primary node ref (kind:key)
  locations TEXT NOT NULL,        -- json [{path,line,column}]
  metrics TEXT,                   -- json {name:number}
  tags TEXT                       -- json [string]
);
CREATE INDEX idx_findings_fingerprint ON findings(fingerprint);
CREATE INDEX idx_findings_rule ON findings(run_id, rule_id);
```

Findings link to existing `evidence` rows (evidence-over-assertion constraint holds).
Fingerprint = hash(rule_id + normalized node path + structural anchor), stable across
line drift. Schema versions independently of the CLI.

Entrypoints: stored as node metadata (`entrypoint: true` on unit/atom nodes), sourced
from config first, framework inference later.

## Analyzer families

All five register in `analyzers.yaml` and follow the existing contract: declare name,
kind, languages, prerequisites; fail soft; record `analyzer_runs` telemetry.

### 1. Cycles (`kind: structural`) — Phase 1

Tarjan SCC over projections of `edges` (imports/depends-on at unit level; optionally
calls at atom level). No new extraction needed — pure graph algorithm.

Rules: `circular-dependency`, `package-cycle`, `cycle-risk-hotspot`.
Rank SCCs by size, fan-in/out centrality, churn of members. Ignore self-loops unless
configured.

### 2. Reachability (`kind: structural`) — Phase 2

BFS from entrypoint set across `imports`/`references`/`depends-on` edges with
confidence propagation (min along path; dynamic-import edges get confidence < 1).
Unreached = candidate findings, gated by confidence and suppression rules.

Rules: `unused-file`, `unused-export`, `unused-symbol`, `unused-dependency`,
`orphan-test`.

Depends on entrypoint modeling. v1: explicit globs in config. v2: inference providers
reusing `FlowDetector`'s route/CLI/queue pattern detection.

Honesty requirement: reflection, dynamic import, convention wiring → lower confidence,
never silent false positives. Missing symbol resolution lowers confidence, never aborts.

### 3. Duplication (`kind: quality`) — Phase 3

Token-stream normalization + windowed fingerprint hashing, merged into clone classes.

Modes: `strict` (exact tokens), `normalized` (whitespace/comments/literals normalized).
`semantic-lite` (identifier normalization) deferred until the first two prove out.

Rules: `duplicate-file`, `duplicate-region`, `clone-class`, `cross-package-duplication`.
Bounded by configurable `minTokens` window and memory budget.

### 4. Hotspots (upgrade existing Ranker/risk) — Phase 3

Not a new analyzer — extend `getRiskAssessment` signals (score, churn, edgeCount,
diagnosticCount) with: cycle membership, duplicate-region count, entrypoint centrality.
Configurable weights. Emits `hotspot`, `complexity-outlier`, `high-centrality-risk`
findings alongside the existing risk levels.

### 5. Architecture rules (`kind: quality`) — Phase 4

Declarative policies evaluated over edges:

- layer ordering (`app -> domain -> infra`, never reverse)
- path restrictions (`src/ui/**` may not import `src/db/**`)
- visibility (internal symbols must not leak through public modules)

Rules: `boundary-violation`, `layering-violation`, `forbidden-dependency`,
`private-api-leak`.

## Config

Extends `.code-spider/config.yaml` (no new config file):

```yaml
intelligence:
  entrypoints:
    - src/index.ts
  cycles:
    enabled: true
  reachability:
    dynamic-import-confidence: 0.5
  duplication:
    mode: normalized
    min-tokens: 40
  hotspots:
    weights: { complexity: 0.3, centrality: 0.2, churn: 0.2, duplication: 0.15, cycles: 0.15 }
  architecture:
    layers: [[app, domain, infra]]
    rules:
      - { from: "src/ui/**", to: "src/db/**", kind: forbid-import }
  suppressions:
    - { rule: unused-file, path: "src/legacy/**", expires: 2026-12-31, owner: platform, reason: migration fallback }
```

Suppressions are analyzable objects: expired or unmatched suppressions emit their own
`stale-suppression` finding.

## CLI surface

```
code-spider intelligence scan [--category <c>] [--format table|json|sarif|md]
code-spider intelligence cycles
code-spider intelligence unused
code-spider intelligence dupes
code-spider intelligence hotspots
code-spider intelligence arch
code-spider intelligence explain <finding-id>
```

All honor global `--json`, `--repo`, `--db`. `explain` surfaces evidence rows for a
finding (existing evidence-over-assertion pattern).

Agent access = same JSON/SARIF output + `explain`; no separate agent API in v1.
Stable fingerprints make findings trackable by CI and agents across runs.

## Constraints carried forward

- Read-only: no source mutation, ever, in this suite. Autofix is out of scope.
- Fail soft: an analyzer crash records the failure, degrades, never poisons the run.
- Local-first: SQLite only, no network.
- Determinism: same input → same findings, same fingerprints. Snapshot-tested.
- Incremental indexing is a separate concern (full re-index today; embeddings
  carry-forward is the existing pattern to extend later). Intelligence analyzers run
  per-run over the indexed graph and are cheap relative to extraction.

## Phases

1. **Findings infrastructure + cycles** — `findings` table, fingerprints, edge
   confidence migration, cycle analyzer, `intelligence scan|cycles|explain`, JSON output.
   Cheapest win: the graph already exists.
2. **Entrypoints + reachability** — config entrypoints, BFS solver, unused-* rules,
   suppressions.
3. **Duplication + hotspot upgrade** — strict/normalized clone detection, Ranker
   signal fold-in, markdown findings report.
4. **Architecture rules + SARIF** — declarative boundary policies, SARIF emitter,
   stale-suppression findings, framework entrypoint inference.

## Test plan

- Golden fixture repos: known unused files/exports, synthetic SCCs (trivial through
  multi-zone), clone fixtures per mode, rule repos with allowed/forbidden edges.
- Determinism snapshots for JSON and SARIF (fingerprint stability is the contract).
- Hermetic — no network, fixtures in-repo, same pattern as embedding tests.

## Acceptance

- Cycles reproducible: same repo state → identical SCC membership and fingerprints.
- Unused-* findings carry confidence semantics and honor suppressions.
- Duplication works in strict and normalized modes with bounded memory.
- Hotspot ranking deterministic under documented weights.
- `--format json` findings round-trip with stable fingerprints across line-shift edits.
