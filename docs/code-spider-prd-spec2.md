# Code-Spider PRD and Technical Specification

## Document purpose

This document defines the product requirements and technical design for **Code-Spider**, a Bun/TypeScript CLI application that crawls, indexes, analyzes, and explains source code repositories through a progressive drill-down model from broad overview to atomic symbol-level detail. The product is designed around layered intelligence: fast structural discovery first, then optional semantic enrichment through existing language servers, linters, and static analyzers when deeper precision is needed.[cite:87][cite:92][cite:95]

The defining product thesis is that repository understanding should behave like progressive disclosure: the user starts with orientation, then narrows into zones, units, flows, and atoms, while retaining visible context, evidence, and navigation breadcrumbs at every level.[cite:42][cite:43][cite:52]

## Product vision

Code-Spider is a local-first code intelligence workbench for unfamiliar repositories. It should help a developer answer four escalating questions: what is this repo, what parts matter most, how does behavior move through it, and what exactly does this symbol or file do.[cite:35][cite:78][cite:80]

The tool must work in constrained environments where the host already has common developer tools installed, such as `git`, `rg`, `find`, `bat`, `sed`, and `awk`, while opportunistically integrating richer analyzers when available. This design avoids rebuilding mature ecosystem intelligence and instead orchestrates multiple truth sources: text truth from grep-like tools, history truth from git, semantic truth from LSP servers, and risk truth from linters and static analyzers.[cite:10][cite:35][cite:87][cite:92]

## Problem statement

Large repositories are difficult to understand because relevant knowledge is scattered across files, directory structure, commit history, implicit conventions, tests, configuration, and language-specific semantics. Existing tools often excel at one narrow layer, such as text search, syntax-aware navigation, or diagnostics, but do not unify these signals into a coherent exploratory model that helps a human move from broad orientation to precise understanding.[cite:1][cite:35][cite:78]

This creates several user pains:

- New contributors do not know where to start reading.[cite:1][cite:35]
- Experienced contributors lose time reconstructing mental models after time away from the codebase.[cite:35][cite:74]
- Grep alone is fast but not semantic; LSP alone is precise but not great at broad-map orientation across a whole repo.[cite:10][cite:87]
- Generated documentation goes stale, while raw search output is not sufficiently explanatory.[cite:62][cite:78]

## Goals

### Primary goals

- Provide a broad-to-atomic drill-down model for any repository.[cite:42][cite:48]
- Build a persistent local knowledge graph in SQLite rather than relying on static Markdown artifacts as the primary source of truth.[cite:61][cite:62][cite:69]
- Combine structural heuristics with optional semantic enrichment from existing analyzers and language servers.[cite:87][cite:92][cite:95]
- Make every explanation evidence-backed and inspectable.[cite:78][cite:80]
- Support a CLI workflow that remains useful even when semantic analyzers are missing or partially configured.[cite:89][cite:92]

### Secondary goals

- Support incremental rescans and time-aware comparison between indexing runs.[cite:62][cite:74]
- Provide environment and capability diagnostics through a `doctor` subcommand.[cite:102][cite:104][cite:113]
- Enable export of reports for onboarding, architecture walkthroughs, and focused investigations.[cite:72][cite:74]

## Non-goals

- Code-Spider is not an IDE replacement.[cite:87][cite:100]
- Code-Spider is not a compiler, build system, or test runner, though it may call external tools to gather intelligence.[cite:92][cite:95]
- Code-Spider is not a hosted SaaS in the initial version; it is a local CLI with a local SQLite database.[cite:61][cite:62]
- Code-Spider does not attempt perfect whole-program understanding for every language in version 1. Instead, it provides graded fidelity based on available evidence sources.[cite:89][cite:94]

## Target users

### Primary user

The primary user is an experienced developer, architect, consultant, or technical lead who needs to make sense of an unfamiliar codebase quickly and repeatedly. This user is comfortable in the terminal, values inspectable evidence, and often works across multiple languages and stacks.[cite:74][cite:78][cite:83]

### Secondary users

- New team members onboarding into a mature codebase.[cite:35]
- Reviewers preparing for risky changes or architectural modifications.[cite:74][cite:80]
- Maintainers returning to old systems after a period away.[cite:74]
- Tooling and DevEx engineers building internal repo-intelligence workflows.[cite:74][cite:78]

## User stories

### Orientation stories

- As a developer, the user wants to understand what kind of repository this is within minutes so that reading can start in the right place.[cite:35]
- As a developer, the user wants to see the dominant languages, top-level zones, likely entrypoints, and hottest files so that effort is focused on the most relevant areas.[cite:1][cite:35]

### Drill-down stories

- As a developer, the user wants to move from repository to subsystem to file to symbol without losing context.[cite:42][cite:43][cite:52]
- As a developer, the user wants each lower-level view to remain connected to higher-level summaries and navigation breadcrumbs so that the investigation does not become disorienting.[cite:47][cite:52]

### Trust stories

- As a developer, the user wants every summary to show why the tool believes it, including grep hits, symbol references, commit history, diagnostics, and tests.[cite:78][cite:80]
- As a developer, the user wants to know when semantic precision is partial or unavailable so that trust is calibrated appropriately.[cite:89][cite:92]

### Diagnostics stories

- As a developer, the user wants a `doctor` command to explain what capabilities are available for the current repo and how to improve them.[cite:102][cite:104][cite:113]

## Product principles

### Progressive disclosure

The tool must reveal just enough information for the next decision and no more. Broad views should optimize for orientation, while narrow views should optimize for precision and evidence.[cite:42][cite:43][cite:45]

### Evidence over assertion

Every explanation should be traceable back to supporting facts. Explanations without evidence should be treated as low-confidence hints, not authoritative descriptions.[cite:78][cite:80]

### Graceful degradation

The tool must provide useful results without LSP or linter integration, then improve fidelity when richer analyzers are available.[cite:89][cite:92][cite:98]

### Local-first design

All repository intelligence should be stored locally in SQLite, making the system fast, portable, inspectable, and usable offline once indexed.[cite:61][cite:62][cite:69]

## Information model

Code-Spider uses a layered hierarchy plus lateral relationships.

### Hierarchical layers

| Layer | Meaning | User question |
|---|---|---|
| Repo | Whole repository | What kind of thing is this? [cite:48] |
| Zone | Top-level subsystem, package, app, service, area | What are the major chunks? [cite:48][cite:52] |
| Flow | Request path, command path, event pipeline, job path | How does work move through it? [cite:47][cite:53] |
| Unit | File, module, directory, class-like unit | Which pieces matter most? [cite:52] |
| Atom | Function, method, symbol, query, config key | What exactly does this piece do? [cite:48][cite:87] |

### Lateral relationships

- Calls
- References
- Imports
- Extends/implements
- Contains
- Defined-in
- Tested-by
- Changed-with
- Configures
- Emits/consumes event
- Routes-to

These relationships enable sideways traversal, not just downward drill-down.[cite:47][cite:53][cite:87]

## Core feature set

### 1. Repository indexing

The `index` command scans the repository, identifies languages and manifest files, inventories files, estimates size, detects top-level zones, computes hotspot metrics, and stores this data in SQLite. It should support initial full indexing and later incremental reindexing.[cite:61][cite:62]

Sources used during indexing include:

- Filesystem structure and file extensions.[cite:20]
- Manifest and config files such as `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, and equivalents.[cite:16][cite:20]
- Git churn and recency information.[cite:35]
- Grep-based evidence for entrypoints, tests, routes, config, and domain terms.[cite:10][cite:11]

### 2. Overview exploration

The `overview` command shows a high-level summary of the repository: dominant languages, likely frameworks, top-level zones, likely entrypoints, hottest units, largest files, and overall analysis readiness.[cite:35][cite:78][cite:80]

This view should answer the question “where should the user start?” rather than merely dumping statistics.[cite:1][cite:35]

### 3. Zone and unit navigation

The `zones`, `show`, and `children` commands expose progressively narrower views over the indexed graph. These commands let the user move from broad chunks into specific files or units while preserving the breadcrumb path back upward.[cite:42][cite:47][cite:52]

Each node view should show:

- Summary
- Why it matters
- Parent context
- Child nodes ranked by relevance
- Related nodes
- Evidence snippets
- Metrics such as LOC, churn, fan-in, fan-out, diagnostics count

### 4. Flow discovery

Flows are derived paths through the system such as login flow, CLI command flow, request flow, worker pipeline, or event path. In version 1, flows may be heuristic rather than complete, using route definitions, queue names, config references, and call/reference graphs.[cite:47][cite:53][cite:80]

Flow views should emphasize sequence and boundaries rather than raw file listings.

### 5. Semantic enrichment

When analyzers are available, the tool should enrich units and atoms with symbol-level understanding through LSP and static-analysis integrations. LSP can provide definitions, references, symbols, hover/type info, diagnostics, semantic tokens, and other language-aware features.[cite:87][cite:90][cite:94]

Static analysis and linters should contribute risk and quality findings such as complexity, suspicious patterns, dead code, smell-like findings, and diagnostics.[cite:92][cite:95][cite:98][cite:101]

### 6. Evidence inspection

Every summarized entity must be explorable in terms of evidence. Evidence includes grep hits, symbol references, diagnostics, git history, manifest clues, tests, and snippets.[cite:78][cite:80][cite:92]

The CLI should never force the user to trust a generated explanation blindly.

### 7. Investigations

An investigation is a saved thread of inquiry. It stores a user question, visited nodes, notes, pinned evidence, and an optional generated summary. This supports real-world developer workflows where a person is trying to answer a concrete question rather than browse everything.[cite:72][cite:75]

### 8. Doctor

The `doctor` subcommand diagnoses environment health, repo health, analyzer readiness, DB state, performance concerns, and expected analysis fidelity. Mature CLI tools often use doctor-style commands for troubleshooting and environment validation, and Code-Spider should adopt the same pattern.[cite:102][cite:104][cite:106][cite:113]

The output should indicate whether the current repo supports:

- Structural exploration
- Hotspot analysis
- Flow heuristics
- Symbol navigation
- Semantic references
- Diagnostics and risk scoring

## Command-line interface

### Proposed command tree

```text
code-spider
  doctor [semantic|repo|perf] [--json]
  index [path] [--incremental] [--semantic]
  overview [path|--run <id>]
  zones [--kind <kind>] [--limit <n>]
  show <node-ref> [--semantic] [--evidence]
  children <node-ref> [--limit <n>] [--sort <score|churn|loc|recent>]
  related <node-ref> [--kind <edge-kind>] [--limit <n>]
  flows [<node-ref>] [--limit <n>]
  refs <symbol-or-node>
  defs <symbol-or-node>
  atoms <unit-ref>
  investigate start <question>
  investigate add <node-ref>
  investigate note <text>
  investigate show <id>
  export report <node-ref|investigation-id> [--format md|json]
```

### Node references

Node references should support a stable human-friendly format, for example:

- `repo:.`
- `zone:backend`
- `unit:src/auth/service.ts`
- `atom:AuthService.authenticate`
- `flow:login`

## Functional requirements

### FR-1 Indexing

- The system shall create a new run record for each indexing operation.[cite:61]
- The system shall support a full scan of a repository root.
- The system shall support incremental refresh when file mtimes or git commit state indicate changes.
- The system shall detect and ignore irrelevant paths such as `.git`, common dependency directories, and build artifacts by default.
- The system shall record which analyzers were available during the run.[cite:92][cite:95]

### FR-2 Structural analysis

- The system shall infer language mix from file extensions and manifest files.[cite:16][cite:20]
- The system shall detect likely zones using directory structure, manifests, and file density.
- The system shall compute file size metrics and hotspot metrics using git history and line counts.[cite:35]
- The system shall detect likely entrypoints using heuristic pattern packs.[cite:10][cite:11]

### FR-3 Semantic analysis

- The system shall detect supported LSP and linter tools available in the environment.[cite:87][cite:92]
- The system shall enrich nodes with symbol data when semantic analyzers are available.[cite:87][cite:94]
- The system shall tolerate partial or failed semantic analysis without failing the overall index.[cite:89][cite:92]
- The system shall record diagnostics, definitions, references, and symbol relationships when available.[cite:87][cite:95]

### FR-4 Navigation

- The system shall allow traversal from repo to zones, units, and atoms.[cite:42][cite:48]
- The system shall expose related-node traversal across lateral relationships.[cite:47][cite:53]
- The system shall maintain breadcrumb context in all human-readable outputs.[cite:47]

### FR-5 Explanation

- The system shall generate summaries at repo, zone, flow, unit, and atom layers.
- The system shall include reasons for relevance or ranking in summaries.
- The system shall expose raw evidence on request for any summary.[cite:78][cite:80]

### FR-6 Doctor

- The system shall provide a doctor command with pass/warn/fail status per check.[cite:104][cite:113]
- The system shall provide a machine-readable JSON mode.[cite:102][cite:109]
- The system shall estimate current analysis fidelity for the active repository.
- The system shall suggest remediation steps for missing capabilities.

### FR-7 Investigations

- The system shall persist investigations in SQLite.
- The system shall allow nodes and evidence to be attached to investigations.
- The system shall support export of investigation reports.

## Non-functional requirements

### Performance

- A structural-only index should begin producing useful overview information quickly, even before full enrichment completes.
- The system should prefer staged indexing, where broad inventory appears first and semantic enrichment follows.
- SQLite queries for common navigation views should feel interactive on local hardware.[cite:61][cite:69]

### Reliability

- Failure of one analyzer must not corrupt the run database.
- Interrupted indexing should leave previous successful runs intact.
- The system should preserve evidence provenance per run.

### Explainability

- Every derived claim should have a confidence level or supporting evidence count.
- The system should clearly distinguish heuristic findings from semantic findings.[cite:89][cite:94]

### Portability

- The product should run locally on developer machines that support Bun and the repository’s installed tooling.
- The first version should avoid requiring a remote service.

## System architecture

Code-Spider uses a layered architecture.

### Layer 1: CLI shell

The CLI parses commands, handles output modes, and routes requests to services.

### Layer 2: Orchestration services

These services coordinate scans, analyzer execution, scoring, summary generation, and navigation.

Suggested modules:

- `CommandRouter`
- `Indexer`
- `AnalyzerRegistry`
- `Navigator`
- `Ranker`
- `Summarizer`
- `DoctorService`
- `InvestigationService`
- `Exporter`

### Layer 3: Adapters

Adapters wrap external tools and normalize their output.

Examples:

- `GitAdapter`
- `RipgrepAdapter`
- `FilesystemAdapter`
- `LineCountAdapter`
- `LspAdapter`
- `LinterAdapter`

### Layer 4: Persistence

SQLite stores runs, nodes, edges, evidence, analyzers, symbols, diagnostics, stats, investigations, and exports.[cite:61][cite:69]

## Data model

### Core tables

```sql
CREATE TABLE runs (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  repo_root TEXT NOT NULL,
  repo_commit TEXT,
  tool_version TEXT
);

CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  path TEXT,
  language TEXT,
  summary TEXT,
  score REAL DEFAULT 0,
  confidence REAL DEFAULT 0,
  metadata_json TEXT,
  UNIQUE(run_id, kind, key)
);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  from_node_id INTEGER NOT NULL,
  to_node_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  weight REAL DEFAULT 1,
  metadata_json TEXT
);

CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  node_id INTEGER,
  edge_id INTEGER,
  kind TEXT NOT NULL,
  source TEXT NOT NULL,
  locator TEXT,
  snippet TEXT,
  score REAL DEFAULT 0
);

CREATE TABLE stats (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  metric TEXT NOT NULL,
  value REAL NOT NULL
);
```

### Semantic tables

```sql
CREATE TABLE analyzers (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  language TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_kind TEXT NOT NULL,
  version TEXT,
  available INTEGER NOT NULL DEFAULT 1,
  metadata_json TEXT
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  symbol_key TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  container_name TEXT,
  signature TEXT,
  type_info TEXT,
  range_json TEXT,
  selection_range_json TEXT,
  metadata_json TEXT
);

CREATE TABLE symbol_edges (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  from_symbol_id INTEGER NOT NULL,
  to_symbol_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  metadata_json TEXT
);

CREATE TABLE diagnostics (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL,
  node_id INTEGER,
  symbol_id INTEGER,
  analyzer_id INTEGER NOT NULL,
  severity TEXT NOT NULL,
  code TEXT,
  message TEXT NOT NULL,
  range_json TEXT,
  metadata_json TEXT
);
```

### Investigation tables

```sql
CREATE TABLE investigations (
  id INTEGER PRIMARY KEY,
  run_id INTEGER,
  title TEXT NOT NULL,
  question TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE investigation_nodes (
  investigation_id INTEGER NOT NULL,
  node_id INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (investigation_id, node_id)
);

CREATE TABLE investigation_evidence (
  investigation_id INTEGER NOT NULL,
  evidence_id INTEGER NOT NULL,
  note TEXT,
  PRIMARY KEY (investigation_id, evidence_id)
);
```

## Analyzer integration model

The analyzer system should be plugin-oriented.

### Analyzer types

- Structural analyzers: file tree, manifests, line counts, churn.[cite:35]
- Heuristic analyzers: route detection, entrypoint detection, test detection, config detection.[cite:10][cite:11]
- Semantic analyzers: LSP providers for definitions, references, symbols, hovers, diagnostics.[cite:87][cite:94]
- Quality analyzers: linters and static-analysis tools.[cite:92][cite:95][cite:98]

### Analyzer contract

Each analyzer plugin should declare:

- Name
- Kind
- Languages supported
- Detection logic
- Prerequisites
- Commands or protocol interface
- Output normalization strategy
- Capability list
- Confidence model

### Suggested interface

```ts
interface AnalyzerPlugin {
  id: string;
  kind: "structural" | "heuristic" | "semantic" | "quality";
  languages: string[];
  detect(ctx: DetectContext): Promise<AnalyzerAvailability>;
  analyze(ctx: AnalyzeContext): Promise<AnalysisResult[]>;
}
```

## Doctor specification

The `doctor` command is both a health check and a capability advisor.[cite:104][cite:113]

### Doctor checks

#### Runtime checks

- Bun version present and supported.
- Writable cache and DB paths.
- SQLite schema current.
- Permission checks for repo root and temp paths.

#### Repo checks

- Valid repo root.
- Git repository presence.
- Readable HEAD and history.
- Reasonable ignore configuration for large generated directories.
- Path count and size warnings.

#### Tooling checks

- `git` detected.
- `rg` detected.
- `bat` detected optionally.
- `sqlite3` detected if shell fallback is needed.
- Presence of relevant semantic analyzers or linters based on repo markers.[cite:92][cite:95]

#### Capability checks

- Structural exploration ready.
- Hotspot analysis ready.
- Flow heuristics partial/ready.
- Semantic navigation partial/ready/unavailable.
- Diagnostics partial/ready/unavailable.

### Doctor output format

Human mode should show pass, warn, and fail indicators with remediation suggestions. JSON mode should include machine-readable status, reasoning, and next actions.[cite:102][cite:109]

## Ranking model

Ranking is central to the product because the user must be guided toward the most important next step.[cite:35][cite:78]

### Candidate signals

- Historical churn.[cite:35]
- Recent churn.[cite:35]
- LOC.
- Fan-in.
- Fan-out.
- Presence of diagnostics.[cite:95]
- Presence of tests.
- Entrypoint likelihood.[cite:10]
- Route or config centrality.[cite:80]
- Investigation relevance.

### Scoring strategy

Scores should be composable, explainable, and transparent. The CLI should be able to say why something ranked highly, for example: “high recent churn, high fan-in, and entrypoint signature.”

## Summary generation model

Summaries should be deterministic templates plus extracted facts in version 1, with optional richer narrative generation layered on top later. This keeps explanations grounded and reproducible.[cite:78][cite:80]

Each summary should include:

- What it is
- Why it matters
- Key relationships
- Why it ranked where it did
- What to inspect next
- Confidence and evidence count

## Output modes

### Human terminal mode

The default mode should emphasize concise summaries, ranked children, breadcrumbs, and evidence hints.

### JSON mode

This mode should enable automation and integration with other tools.

### Markdown export

Used for onboarding briefs, investigation reports, and architecture notes.[cite:72][cite:74]

## Example navigation journey

A typical user path may look like this:

1. `code-spider doctor`
2. `code-spider index .`
3. `code-spider overview`
4. `code-spider zones`
5. `code-spider show zone:backend`
6. `code-spider children zone:backend --sort score`
7. `code-spider show unit:src/auth/service.ts --semantic`
8. `code-spider atoms unit:src/auth/service.ts`
9. `code-spider refs atom:AuthService.authenticate`
10. `code-spider investigate start "How does login work?"`

This sequence reflects the progressive-disclosure design goal from broad orientation to atomic detail.[cite:42][cite:43][cite:48]

## Risks and mitigations

### Risk: analyzer inconsistency

LSP and linter quality varies by language and environment.[cite:89][cite:92][cite:98]

Mitigation: keep structural analysis useful on its own, record analyzer provenance, and surface capability ceilings clearly through `doctor`.[cite:104][cite:113]

### Risk: stale or misleading summaries

Heuristic findings can drift from reality as repos evolve.[cite:78][cite:80]

Mitigation: tie summaries to runs, expose evidence, allow incremental refresh, and distinguish heuristic from semantic certainty.[cite:62][cite:89]

### Risk: performance collapse in huge repos

Semantic enrichment across an entire monorepo may be too expensive.[cite:61][cite:69]

Mitigation: stage indexing, enrich on demand, and prioritize hot or user-selected zones.

## Milestones

### Milestone 1: Structural MVP

- CLI skeleton in Bun/TypeScript
- SQLite schema for runs, nodes, edges, evidence, stats
- Structural inventory and hotspot analysis
- Overview, zones, show, children commands
- Basic doctor command

### Milestone 2: Semantic MVP

- Analyzer registry
- At least one LSP-backed integration path
- Symbols, symbol edges, diagnostics tables
- `atoms`, `refs`, and `defs` commands
- Capability-aware doctor semantic checks

### Milestone 3: Investigations and exports

- Investigation persistence
- Markdown export for investigation and subsystem reports
- Time-aware run comparison

### Milestone 4: Flow intelligence

- Derived flow graphs
- Better route and event-path inference
- Cross-zone journey explanations

## Success criteria

The product should be considered successful when:

- A user can identify where to start in an unfamiliar repo within a few minutes.[cite:35]
- A user can traverse from overview to a specific symbol without losing context.[cite:42][cite:47]
- The tool remains useful even without full semantic tooling.[cite:89][cite:92]
- Semantic tooling, when available, materially improves symbol navigation and trust.[cite:87][cite:94]
- The doctor command accurately explains capability gaps and suggested fixes.[cite:104][cite:113]
- Investigation exports are good enough to share with teammates as onboarding or architecture briefs.[cite:72][cite:74]

## Open questions

- Should run comparisons be automatic or explicit?
- Should flows be first-class indexed nodes in version 1 or derived views only?
- How should analyzer sandboxing and timeouts be configured per language?
- Should notes and investigations be per-user only or support future shared sync?
- Should summaries remain deterministic only, or support optional LLM-assisted narration later?

## Final recommendation

The strongest version of Code-Spider is a layered local intelligence system: fast structural map first, SQLite as the source of truth, optional semantic enrichment through existing LSP and analysis tools, and a CLI built around progressive drill-down plus evidence-backed explanation.[cite:42][cite:61][cite:87][cite:92]

That combination makes the tool practically useful in constrained real-world environments while leaving room for deeper semantic precision when the ecosystem supports it.[cite:89][cite:95]

## Dual-purpose product positioning

Code-Spider is explicitly a dual-purpose system. Its first audience is the solo developer who needs to understand an unfamiliar or long-neglected repository quickly. Its second audience is agentic coding tools such as Claude Code, Codex, and similar systems that need structured, scoped, evidence-backed repository context in order to plan and execute changes more reliably.[cite:21][cite:146][cite:149][cite:154][cite:155]

This positioning changes the product from a simple repository explorer into a local code-intelligence substrate. For humans, it is an exploratory CLI that supports orientation, drill-down, explanation, and investigation. For AI-assisted workflows, it is a context broker that can package stable, machine-readable slices of repository intelligence for planning, retrieval, blast-radius analysis, and scoped execution.[cite:21][cite:74][cite:78][cite:147][cite:154]

### Product statement

Code-Spider is a local-first code intelligence system for both human developers and AI coding agents. It helps solo developers move from broad architectural understanding to atomic symbol-level detail, and it helps coding assistants operate on large codebases with structured context, explicit evidence, and bounded scope instead of oversized prompts or ad hoc file dumps.[cite:21][cite:146][cite:149][cite:154][cite:155]

### Dual-audience requirements

The product must satisfy both audiences without splitting into separate tools.

#### Human-facing requirements

- Fast overview and drill-down navigation.[cite:74][cite:78]
- Ranked suggestions for where to start reading or modifying code.[cite:35][cite:78]
- Clear summaries with evidence and confidence indicators.[cite:78][cite:80]
- Investigation support for concrete questions such as “How does login work?” or “Where are billing retries handled?”[cite:72][cite:75]

#### Agent-facing requirements

- Structured JSON output on all core commands.[cite:147][cite:154]
- Stable node references and predictable schemas where possible.
- Small, scoped query results suitable for iterative tool use rather than giant monolithic context dumps.[cite:149][cite:155]
- Evidence and provenance fields so downstream agents can reason about confidence and source quality.[cite:78][cite:154]
- Capability-aware responses so agents know when semantic results are partial, unavailable, or degraded.[cite:89][cite:104]

### Additional goals for the dual-purpose model

- Improve reliability of agentic coding workflows on large codebases by exposing explicit structure, relationships, and scoped context.[cite:21][cite:146][cite:149][cite:154]
- Reduce prompt bloat by allowing assistants to retrieve only the relevant repository slice for the current task.[cite:149][cite:155]
- Support multi-step planning workflows where an agent first asks for map data, then targeted context, then impact analysis, then implementation hints.[cite:146][cite:154][cite:155]

### New command requirements

To support both solo developer workflows and agent-assisted workflows, Code-Spider should add or emphasize these commands.

- `bundle <node-ref|investigation-id>` — export a compact task-scoped context package, including summary, related nodes, evidence, key files, and relevant symbols.[cite:149][cite:155]
- `blast-radius <node-ref>` — estimate likely impact based on references, callers, tests, co-change patterns, and subsystem boundaries.[cite:74][cite:80]
- `patterns <concept|node-ref>` — surface similar implementations or precedent patterns elsewhere in the repo, which is especially useful for AI-assisted change planning.[cite:149]
- `overview --json`, `show --json`, `related --json`, `flows --json`, `refs --json`, and `defs --json` — structured output must be considered first-class, not optional polish.[cite:147][cite:154]

### Output contract updates

All core commands should support both human-readable terminal output and structured machine-readable JSON. The JSON contract should include:

- Node identity and kind.
- Summary.
- Confidence.
- Rank and ranking reasons when applicable.
- Parent and breadcrumb context.
- Child and related node references.
- Evidence references with provenance.
- Capability status, including whether semantic analysis is complete, partial, timed out, or unavailable.[cite:78][cite:89][cite:104][cite:154]

This is necessary because AI tools are most effective when they can query a local system iteratively with compact, reliable responses rather than infer everything from a raw code dump.[cite:149][cite:154][cite:155]

### Investigation model updates

Investigations should be treated as shared objects between humans and agents. A human should be able to begin an investigation, inspect nodes, attach notes, and later let an AI assistant consume the same investigation as structured task context. Likewise, an agent should be able to assemble an investigation bundle that a human can later review and refine.[cite:72][cite:75][cite:146][cite:154]

This means investigations should store:

- Original question.
- Scope and selected nodes.
- Key evidence.
- Notes.
- Generated summary.
- Confidence and unresolved gaps.
- Exportable machine-readable form.

### Doctor updates for dual-purpose usage

The `doctor` subcommand should report not only environment health but also suitability for agent-assisted workflows. In addition to structural and semantic readiness, it should estimate whether the environment supports high-quality machine-facing context generation, including analyzer health, stable indexing, JSON output readiness, and expected semantic fidelity for the current repository.[cite:102][cite:104][cite:113]

Suggested additional doctor outputs:

- `agent_context_ready`: yes/partial/no.
- `structured_output_ready`: yes/no.
- `semantic_fidelity`: structural only / partial semantic / strong semantic.
- `recommended_profile`: safe / semantic / permissive.
- `recommended_query_style`: overview-first, zone-first, or direct-symbol depending on repo readiness and analyzer availability.[cite:104][cite:113]

### Architecture implications

The dual-purpose positioning implies several architectural requirements:

- The SQLite schema must remain the canonical source of truth for both human and agent workflows.[cite:61][cite:69]
- Summaries must remain grounded in evidence and not rely on opaque generation alone.[cite:78][cite:80]
- Command outputs must be stable enough to serve as tool-call responses in agent workflows.[cite:147][cite:154]
- The analyzer layer must support partial enrichment and explicit capability signaling rather than binary success/failure.[cite:87][cite:89][cite:104]
- The navigation model must be queryable by path, kind, score, relation, and task relevance.

### Success criteria updates

In addition to the existing success criteria, Code-Spider should be considered successful in the dual-purpose sense when:

- A solo developer can orient in an unfamiliar repository quickly and move to a specific change target with evidence-backed confidence.[cite:35][cite:74][cite:78]
- An AI coding assistant can retrieve compact, structured context for a task without needing a massive prompt or full repo dump.[cite:149][cite:154][cite:155]
- Human and agent workflows can share investigations, bundles, and stable node references.
- The system improves planning quality and reduces blind edits in complex repositories by exposing structure, precedent, and likely impact.[cite:146][cite:149][cite:154]

### Future extension

A later version of Code-Spider should consider exposing its core operations through an MCP-style or similar machine-consumable tool interface so AI coding assistants can query the repository graph directly instead of shelling out through text-only wrappers. This should be considered an extension of the same product direction rather than a separate product line.[cite:147][cite:154]
