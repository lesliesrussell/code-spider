# Code-Spider PRD and Technical Specification

## Document purpose

This document defines the product requirements and technical design for **Code-Spider**, a Bun/TypeScript CLI application that crawls, indexes, analyzes, and explains source code repositories through a progressive drill-down model from broad overview to atomic symbol-level detail. The product is designed around layered intelligence: fast structural discovery first, then optional semantic enrichment through existing language servers, linters, and static analyzers when deeper precision is needed. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

The defining product thesis is that repository understanding should behave like progressive disclosure: the user starts with orientation, then narrows into zones, units, flows, and atoms, while retaining visible context, evidence, and navigation breadcrumbs at every level. [versions](https://versions.com/interaction/progressive-disclosure-the-art-of-revealing-just-enough/)

## Product vision

Code-Spider is a local-first code intelligence workbench for unfamiliar repositories. It should help a developer answer four escalating questions: what is this repo, what parts matter most, how does behavior move through it, and what exactly does this symbol or file do. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)

Code-Spider is a dual-purpose local code intelligence system. It serves solo developers as an exploratory CLI for understanding repositories from broad architecture to atomic symbols, and it serves agentic coding tools as a structured context substrate for planning, scoped retrieval, evidence-backed reasoning, and change-impact analysis.

The tool must work in constrained environments where the host already has common developer tools installed, such as `git`, `rg`, `find`, `bat`, `sed`, and `awk`, while opportunistically integrating richer analyzers when available. This design avoids rebuilding mature ecosystem intelligence and instead orchestrates multiple truth sources: text truth from grep-like tools, history truth from git, semantic truth from LSP servers, and risk truth from linters and static analyzers. [jetbrains](https://www.jetbrains.com/pages/static-code-analysis-guide/linters)

## Problem statement

Large repositories are difficult to understand because relevant knowledge is scattered across files, directory structure, commit history, implicit conventions, tests, configuration, and language-specific semantics. Existing tools often excel at one narrow layer, such as text search, syntax-aware navigation, or diagnostics, but do not unify these signals into a coherent exploratory model that helps a human move from broad orientation to precise understanding. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)

This creates several user pains:

- New contributors do not know where to start reading. [reddit](https://www.reddit.com/r/ExperiencedDevs/comments/16gxkft/how_to_quickly_understand_large_codebases/)
- Experienced contributors lose time reconstructing mental models after time away from the codebase. [jellyfish](https://jellyfish.co/blog/best-developer-experience-tools/)
- Grep alone is fast but not semantic; LSP alone is precise but not great at broad-map orientation across a whole repo. [github](https://github.com/burntsushi/ripgrep)
- Generated documentation goes stale, while raw search output is not sufficiently explanatory. [nickgeorge](https://nickgeorge.net/science/organizing-scientific-metadata-with-sqlite-and-python/)

## Goals

Enable fast human orientation and drill-down in unfamiliar repositories.

Provide structured, machine-readable context for AI coding assistants operating on large codebases.

Improve AI coding reliability by exposing scoped context, architectural relationships, and evidence-backed summaries rather than raw file dumps.

Recommended additions
If you want to fully embrace the dual-purpose design, I’d add these features to the spec:

--json on every core command.

bundle command for scoped context export.

blast-radius command for likely impact analysis.

patterns command for “show me similar existing implementations.”

investigate objects designed to be consumable by both humans and agents.

Optional MCP-style adapter later, so coding assistants can query Code-Spider as a tool endpoint.



### Primary goals

- Provide a broad-to-atomic drill-down model for any repository. [dev](https://dev.to/icepanel/how-to-create-interactive-zoomable-software-architecture-diagrams-5315)
- Build a persistent local knowledge graph in SQLite rather than relying on static Markdown artifacts as the primary source of truth. [dev](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai)
- Combine structural heuristics with optional semantic enrichment from existing analyzers and language servers. [oligo](https://www.oligo.security/academy/static-code-analysis)
- Make every explanation evidence-backed and inspectable. [vfunction](https://vfunction.com/blog/software-architecture-tools/)
- Support a CLI workflow that remains useful even when semantic analyzers are missing or partially configured. [en.wikipedia](https://en.wikipedia.org/wiki/Language_Server_Protocol)

### Secondary goals

- Support incremental rescans and time-aware comparison between indexing runs. [jellyfish](https://jellyfish.co/blog/best-developer-experience-tools/)
- Provide environment and capability diagnostics through a `doctor` subcommand. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_doctor_commands_unified.htm)
- Enable export of reports for onboarding, architecture walkthroughs, and focused investigations. [kdnuggets](https://www.kdnuggets.com/7-must-have-tools-for-your-coding-workflow)

## Non-goals

- Code-Spider is not an IDE replacement. [learn.microsoft](https://learn.microsoft.com/en-us/visualstudio/extensibility/language-server-protocol?view=visualstudio)
- Code-Spider is not a compiler, build system, or test runner, though it may call external tools to gather intelligence. [jetbrains](https://www.jetbrains.com/pages/static-code-analysis-guide/linters)
- Code-Spider is not a hosted SaaS in the initial version; it is a local CLI with a local SQLite database. [nickgeorge](https://nickgeorge.net/science/organizing-scientific-metadata-with-sqlite-and-python/)
- Code-Spider does not attempt perfect whole-program understanding for every language in version 1. Instead, it provides graded fidelity based on available evidence sources. [emergentmind](https://www.emergentmind.com/topics/language-server-protocol-lsp)

## Target users

### Primary user

The primary user is an experienced developer, architect, consultant, or technical lead who needs to make sense of an unfamiliar codebase quickly and repeatedly. This user is comfortable in the terminal, values inspectable evidence, and often works across multiple languages and stacks. [cerbos](https://www.cerbos.dev/blog/best-open-source-tools-software-architects)

### Secondary users

- New team members onboarding into a mature codebase. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- Reviewers preparing for risky changes or architectural modifications. [vfunction](https://vfunction.com/blog/software-architecture-tools/)
- Maintainers returning to old systems after a period away. [jellyfish](https://jellyfish.co/blog/best-developer-experience-tools/)
- Tooling and DevEx engineers building internal repo-intelligence workflows. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)

## User stories

### Orientation stories

- As a developer, the user wants to understand what kind of repository this is within minutes so that reading can start in the right place. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- As a developer, the user wants to see the dominant languages, top-level zones, likely entrypoints, and hottest files so that effort is focused on the most relevant areas. [reddit](https://www.reddit.com/r/ExperiencedDevs/comments/16gxkft/how_to_quickly_understand_large_codebases/)

### Drill-down stories

- As a developer, the user wants to move from repository to subsystem to file to symbol without losing context. [ixdf](https://ixdf.org/literature/topics/progressive-disclosure)
- As a developer, the user wants each lower-level view to remain connected to higher-level summaries and navigation breadcrumbs so that the investigation does not become disorienting. [design.gitlab](https://design.gitlab.com/patterns/progressive-disclosure)

### Trust stories

- As a developer, the user wants every summary to show why the tool believes it, including grep hits, symbol references, commit history, diagnostics, and tests. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)
- As a developer, the user wants to know when semantic precision is partial or unavailable so that trust is calibrated appropriately. [en.wikipedia](https://en.wikipedia.org/wiki/Language_Server_Protocol)

### Diagnostics stories

- As a developer, the user wants a `doctor` command to explain what capabilities are available for the current repo and how to improve them. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_trouble_doctor.htm)

## Product principles

### Progressive disclosure

The tool must reveal just enough information for the next decision and no more. Broad views should optimize for orientation, while narrow views should optimize for precision and evidence. [uxmatters](https://www.uxmatters.com/mt/archives/2020/05/designing-for-progressive-disclosure.php)

### Evidence over assertion

Every explanation should be traceable back to supporting facts. Explanations without evidence should be treated as low-confidence hints, not authoritative descriptions. [vfunction](https://vfunction.com/blog/software-architecture-tools/)

### Graceful degradation

The tool must provide useful results without LSP or linter integration, then improve fidelity when richer analyzers are available. [snyk](https://snyk.io/blog/10-dimensions-of-python-static-analysis/)

### Local-first design

All repository intelligence should be stored locally in SQLite, making the system fast, portable, inspectable, and usable offline once indexed. [biocypher](https://biocypher.org/BioCypher/reference/outputs/sqlite-output/)

## Information model

Code-Spider uses a layered hierarchy plus lateral relationships.

### Hierarchical layers

| Layer | Meaning | User question |
|---|---|---|
| Repo | Whole repository | What kind of thing is this?  [dev](https://dev.to/icepanel/how-to-create-interactive-zoomable-software-architecture-diagrams-5315) |
| Zone | Top-level subsystem, package, app, service, area | What are the major chunks?  [dev](https://dev.to/icepanel/how-to-create-interactive-zoomable-software-architecture-diagrams-5315) |
| Flow | Request path, command path, event pipeline, job path | How does work move through it?  [userpilot](https://userpilot.com/blog/navigation-ux/) |
| Unit | File, module, directory, class-like unit | Which pieces matter most?  [design.gitlab](https://design.gitlab.com/patterns/progressive-disclosure) |
| Atom | Function, method, symbol, query, config key | What exactly does this piece do?  [dev](https://dev.to/icepanel/how-to-create-interactive-zoomable-software-architecture-diagrams-5315) |

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

These relationships enable sideways traversal, not just downward drill-down. [userpilot](https://userpilot.com/blog/navigation-ux/)

## Core feature set

### 1. Repository indexing

The `index` command scans the repository, identifies languages and manifest files, inventories files, estimates size, detects top-level zones, computes hotspot metrics, and stores this data in SQLite. It should support initial full indexing and later incremental reindexing. [dev](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai)

Sources used during indexing include:

- Filesystem structure and file extensions. [blog.osamathe](https://blog.osamathe.dev/blog/monorepo_experiment_project/)
- Manifest and config files such as `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, and equivalents. [fnjoin](https://fnjoin.com/post/2024-03-04-projen-pdk-nx/)
- Git churn and recency information. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- Grep-based evidence for entrypoints, tests, routes, config, and domain terms. [dev](https://dev.to/markbosire/effortlessly-navigate-and-search-large-scale-repositories-with-fzf-and-ripgrep-376n)

### 2. Overview exploration

The `overview` command shows a high-level summary of the repository: dominant languages, likely frameworks, top-level zones, likely entrypoints, hottest units, largest files, and overall analysis readiness. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)

This view should answer the question “where should the user start?” rather than merely dumping statistics. [reddit](https://www.reddit.com/r/ExperiencedDevs/comments/16gxkft/how_to_quickly_understand_large_codebases/)

### 3. Zone and unit navigation

The `zones`, `show`, and `children` commands expose progressively narrower views over the indexed graph. These commands let the user move from broad chunks into specific files or units while preserving the breadcrumb path back upward. [versions](https://versions.com/interaction/progressive-disclosure-the-art-of-revealing-just-enough/)

Each node view should show:

- Summary
- Why it matters
- Parent context
- Child nodes ranked by relevance
- Related nodes
- Evidence snippets
- Metrics such as LOC, churn, fan-in, fan-out, diagnostics count

### 4. Flow discovery

Flows are derived paths through the system such as login flow, CLI command flow, request flow, worker pipeline, or event path. In version 1, flows may be heuristic rather than complete, using route definitions, queue names, config references, and call/reference graphs. [justinmind](https://www.justinmind.com/blog/navigation-design-almost-everything-you-need-to-know/)

Flow views should emphasize sequence and boundaries rather than raw file listings.

### 5. Semantic enrichment

When analyzers are available, the tool should enrich units and atoms with symbol-level understanding through LSP and static-analysis integrations. LSP can provide definitions, references, symbols, hover/type info, diagnostics, semantic tokens, and other language-aware features. [github](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.18/specification.md)

Static analysis and linters should contribute risk and quality findings such as complexity, suspicious patterns, dead code, smell-like findings, and diagnostics. [blog.codacy](https://blog.codacy.com/static-code-analysis-tools)

### 6. Evidence inspection

Every summarized entity must be explorable in terms of evidence. Evidence includes grep hits, symbol references, diagnostics, git history, manifest clues, tests, and snippets. [jetbrains](https://www.jetbrains.com/pages/static-code-analysis-guide/linters)

The CLI should never force the user to trust a generated explanation blindly.

### 7. Investigations

An investigation is a saved thread of inquiry. It stores a user question, visited nodes, notes, pinned evidence, and an optional generated summary. This supports real-world developer workflows where a person is trying to answer a concrete question rather than browse everything. [timheuer](https://timheuer.com/blog/my-ai-copilot-developer-workflow-relies-on-planning/)

### 8. Doctor

The `doctor` subcommand diagnoses environment health, repo health, analyzer readiness, DB state, performance concerns, and expected analysis fidelity. Mature CLI tools often use doctor-style commands for troubleshooting and environment validation, and Code-Spider should adopt the same pattern. [github](https://github.com/wp-cli/doctor-command)

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

- The system shall create a new run record for each indexing operation. [dev](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai)
- The system shall support a full scan of a repository root.
- The system shall support incremental refresh when file mtimes or git commit state indicate changes.
- The system shall detect and ignore irrelevant paths such as `.git`, common dependency directories, and build artifacts by default.
- The system shall record which analyzers were available during the run. [oligo](https://www.oligo.security/academy/static-code-analysis)

### FR-2 Structural analysis

- The system shall infer language mix from file extensions and manifest files. [blog.osamathe](https://blog.osamathe.dev/blog/monorepo_experiment_project/)
- The system shall detect likely zones using directory structure, manifests, and file density.
- The system shall compute file size metrics and hotspot metrics using git history and line counts. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- The system shall detect likely entrypoints using heuristic pattern packs. [github](https://github.com/burntsushi/ripgrep)

### FR-3 Semantic analysis

- The system shall detect supported LSP and linter tools available in the environment. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- The system shall enrich nodes with symbol data when semantic analyzers are available. [emergentmind](https://www.emergentmind.com/topics/language-server-protocol-lsp)
- The system shall tolerate partial or failed semantic analysis without failing the overall index. [en.wikipedia](https://en.wikipedia.org/wiki/Language_Server_Protocol)
- The system shall record diagnostics, definitions, references, and symbol relationships when available. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

### FR-4 Navigation

- The system shall allow traversal from repo to zones, units, and atoms. [dev](https://dev.to/icepanel/how-to-create-interactive-zoomable-software-architecture-diagrams-5315)
- The system shall expose related-node traversal across lateral relationships. [userpilot](https://userpilot.com/blog/navigation-ux/)
- The system shall maintain breadcrumb context in all human-readable outputs. [userpilot](https://userpilot.com/blog/navigation-ux/)

### FR-5 Explanation

- The system shall generate summaries at repo, zone, flow, unit, and atom layers.
- The system shall include reasons for relevance or ranking in summaries.
- The system shall expose raw evidence on request for any summary. [vfunction](https://vfunction.com/blog/software-architecture-tools/)

### FR-6 Doctor

- The system shall provide a doctor command with pass/warn/fail status per check. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_trouble_doctor.htm)
- The system shall provide a machine-readable JSON mode. [hooklistener](https://www.hooklistener.com/guides/cli-diagnostics)
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
- SQLite queries for common navigation views should feel interactive on local hardware. [biocypher](https://biocypher.org/BioCypher/reference/outputs/sqlite-output/)

### Reliability

- Failure of one analyzer must not corrupt the run database.
- Interrupted indexing should leave previous successful runs intact.
- The system should preserve evidence provenance per run.

### Explainability

- Every derived claim should have a confidence level or supporting evidence count.
- The system should clearly distinguish heuristic findings from semantic findings. [emergentmind](https://www.emergentmind.com/topics/language-server-protocol-lsp)

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

SQLite stores runs, nodes, edges, evidence, analyzers, symbols, diagnostics, stats, investigations, and exports. [biocypher](https://biocypher.org/BioCypher/reference/outputs/sqlite-output/)

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

- Structural analyzers: file tree, manifests, line counts, churn. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- Heuristic analyzers: route detection, entrypoint detection, test detection, config detection. [dev](https://dev.to/markbosire/effortlessly-navigate-and-search-large-scale-repositories-with-fzf-and-ripgrep-376n)
- Semantic analyzers: LSP providers for definitions, references, symbols, hovers, diagnostics. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- Quality analyzers: linters and static-analysis tools. [snyk](https://snyk.io/blog/10-dimensions-of-python-static-analysis/)

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

The `doctor` command is both a health check and a capability advisor. [github](https://github.com/wp-cli/doctor-command)

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
- Presence of relevant semantic analyzers or linters based on repo markers. [oligo](https://www.oligo.security/academy/static-code-analysis)

#### Capability checks

- Structural exploration ready.
- Hotspot analysis ready.
- Flow heuristics partial/ready.
- Semantic navigation partial/ready/unavailable.
- Diagnostics partial/ready/unavailable.

### Doctor output format

Human mode should show pass, warn, and fail indicators with remediation suggestions. JSON mode should include machine-readable status, reasoning, and next actions. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/cli_reference_doctor_commands_unified.htm)

## Ranking model

Ranking is central to the product because the user must be guided toward the most important next step. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)

### Candidate signals

- Historical churn. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- Recent churn. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- LOC.
- Fan-in.
- Fan-out.
- Presence of diagnostics. [oligo](https://www.oligo.security/academy/static-code-analysis)
- Presence of tests.
- Entrypoint likelihood. [github](https://github.com/burntsushi/ripgrep)
- Route or config centrality. [vfunction](https://vfunction.com/blog/software-architecture-tools/)
- Investigation relevance.

### Scoring strategy

Scores should be composable, explainable, and transparent. The CLI should be able to say why something ranked highly, for example: “high recent churn, high fan-in, and entrypoint signature.”

## Summary generation model

Summaries should be deterministic templates plus extracted facts in version 1, with optional richer narrative generation layered on top later. This keeps explanations grounded and reproducible. [glean](https://www.glean.com/perspectives/what-is-code-intelligence-and-how-do-ai-search-tools-provide-it)

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

Used for onboarding briefs, investigation reports, and architecture notes. [kdnuggets](https://www.kdnuggets.com/7-must-have-tools-for-your-coding-workflow)

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

This sequence reflects the progressive-disclosure design goal from broad orientation to atomic detail. [ixdf](https://ixdf.org/literature/topics/progressive-disclosure)

## Risks and mitigations

### Risk: analyzer inconsistency

LSP and linter quality varies by language and environment. [snyk](https://snyk.io/blog/10-dimensions-of-python-static-analysis/)

Mitigation: keep structural analysis useful on its own, record analyzer provenance, and surface capability ceilings clearly through `doctor`. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_trouble_doctor.htm)

### Risk: stale or misleading summaries

Heuristic findings can drift from reality as repos evolve. [vfunction](https://vfunction.com/blog/software-architecture-tools/)

Mitigation: tie summaries to runs, expose evidence, allow incremental refresh, and distinguish heuristic from semantic certainty. [nickgeorge](https://nickgeorge.net/science/organizing-scientific-metadata-with-sqlite-and-python/)

### Risk: performance collapse in huge repos

Semantic enrichment across an entire monorepo may be too expensive. [dev](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai)

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

The recommendation is to use **default-deny sandboxing**, **least-privilege analyzer profiles**, **fresh approval for policy violations**, **incremental analysis where possible**, and **separate timeout budgets for detection, startup, request, and idle phases** so the tool stays safe and responsive while still supporting deeper semantic work when available. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

## Analyzer sandboxing and timeout policy

Analyzer sandboxing and timeout configuration should be treated as part of the core product architecture, not as implementation detail. Code-Spider executes third-party tools that may parse large codebases, traverse dependency graphs, or access local development state, so it must enforce clear isolation boundaries, bounded lifetimes, and predictable fallback behavior. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)

The policy should follow four principles:

- Default-deny isolation for filesystem, network, and process behavior, with explicit allowlists for legitimate needs. [rippling](https://www.rippling.com/blog/agentic-ai-security)
- Least-privilege execution, so analyzers receive only the access required for the requested operation. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- Phase-specific timeout budgets, since analyzer detection, startup, and request handling have different performance characteristics. [pvs-studio](https://pvs-studio.com/en/docs/manual/0024/)
- Graceful degradation, so semantic failures never block structural exploration or corrupt the repository intelligence graph. [augmentcode](https://www.augmentcode.com/guides/static-code-analysis-best-practices-enterprise)

### Security model

Code-Spider should assume that analyzers are useful but not inherently trustworthy. Language servers, linters, and static analyzers often execute within the user’s environment and may touch local caches, build metadata, dependency trees, or configuration files, which means unrestricted execution creates avoidable risk. [code.claude](https://code.claude.com/docs/en/sandboxing)

The default sandbox policy should therefore be:

- Read access limited to the repository root, Code-Spider-owned temporary directories, and explicitly allowlisted language-specific cache paths when needed. [code.claude](https://code.claude.com/docs/en/sandboxing)
- Write access limited to Code-Spider-owned cache, temp, and SQLite database paths only. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- Network access disabled by default, with explicit per-run approval required for any analyzer that needs remote access. [rippling](https://www.rippling.com/blog/agentic-ai-security)
- No persistent approval caching for policy violations; each dangerous action that exceeds the default sandbox should require fresh approval. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- Enterprise or system-level denylisted paths, such as shell startup files, SSH material, unrelated home directories, or secrets stores, must never become writable through user-level overrides. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)

This model keeps analyzer execution practical while preventing Code-Spider from quietly inheriting the full trust surface of the user shell. [rippling](https://www.rippling.com/blog/agentic-ai-security)

### Sandbox profiles

Code-Spider should define three standard sandbox profiles so users can reason about capability versus risk without understanding every analyzer’s internal behavior. [code.claude](https://code.claude.com/docs/en/sandboxing)

| Profile | Intended use | Filesystem scope | Network | Timeout posture |
|---|---|---|---|---|
| `safe` | Default broad exploration and structural indexing | Repo root + Code-Spider temp/cache only  [code.claude](https://code.claude.com/docs/en/sandboxing) | Disabled  [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) | Strict |
| `semantic` | On-demand symbol navigation and diagnostics | Repo root + approved language-specific local cache or env paths  [code.claude](https://code.claude.com/docs/en/sandboxing) | Disabled by default  [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) | Moderate |
| `permissive` | Edge-case repos and analyzers needing wider local context | Explicit allowlist beyond repo root, still no arbitrary write outside Code-Spider paths  [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) | Optional, per analyzer approval  [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/) | Relaxed but bounded |

The `safe` profile should be the default for `index`, `overview`, and general navigation. The `semantic` profile should be activated when the user explicitly requests deeper symbol-aware analysis or when `doctor` determines the repo is well-configured for local semantic tooling. The `permissive` profile should remain opt-in and clearly surfaced as higher risk. [developer.salesforce](https://developer.salesforce.com/docs/atlas.en-us.sfdx_setup.meta/sfdx_setup/sfdx_setup_trouble_doctor.htm)

### Timeout phases

Analyzer execution should use distinct timeout classes instead of a single global timeout, because the initialization path of a language server is very different from a single symbol lookup or a workspace-wide references query. [mintlify](https://mintlify.com/Glass-HQ/Glass/development/navigation)

Code-Spider should implement the following timeout classes:

| Timeout class | Purpose | Default policy |
|---|---|---|
| Detect timeout | Verify tool presence and basic responsiveness | 3 seconds  [mintlify](https://mintlify.com/Glass-HQ/Glass/development/navigation) |
| Startup timeout | Launch process and complete initialization/handshake | 20 seconds default; longer for high-cost analyzers  [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) |
| Request timeout | Bound individual semantic or quality-analysis requests | 8 seconds file-local default; 45 seconds workspace-wide default; 90 seconds hard cap  [mintlify](https://mintlify.com/Glass-HQ/Glass/development/navigation) |
| Idle timeout | Reclaim analyzer processes after inactivity | 10 minutes default, configurable  [github](https://github.com/redhat-developer/vscode-xml/issues/540) |

This separation gives Code-Spider better control over responsiveness, avoids over-penalizing slow-to-start analyzers, and supports predictable cancellation behavior for long-running requests. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

### Cancellation and partial results

When possible, Code-Spider should support request cancellation and partial-result handling for LSP-driven operations. The LSP specification explicitly allows cancellation and notes that canceled requests must still return a response, and the protocol also supports work-done and partial-result progress patterns for long-running operations. [github](https://github.com/microsoft/language-server-protocol/issues/786)

The runtime policy should therefore include:

- Cancel in-flight semantic requests when the user navigates away or supersedes the query. [github](https://github.com/microsoft/language-server-protocol/issues/786)
- Capture partial results when analyzers support them, especially for long-running workspace symbol or reference queries. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/specification-3-15/)
- Record cancellation, timeout, and partial-result state in SQLite for observability and later troubleshooting.
- Distinguish “no result” from “timed out” and from “partial result returned.”

This improves both interactivity and trust because the user can tell the difference between absence of evidence and incomplete analysis. [github](https://github.com/microsoft/language-server-protocol/issues/786)

### Per-language timeout guidance

Timeouts should be specialized by language and analyzer cost profile rather than kept uniform across the whole system. Language ecosystems differ significantly in startup cost, dependency graph complexity, and workspace indexing behavior, so per-language defaults are necessary for a tool that aims to feel responsive across repositories. [oligo](https://www.oligo.security/academy/static-code-analysis)

| Language / ecosystem | Startup timeout | File-local request timeout | Workspace request timeout | Notes |
|---|---:|---:|---:|---|
| TypeScript / JavaScript | 20–30s | 5–10s | 30–90s | Project graph and `node_modules` can increase cost substantially  [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) |
| Python | 15–30s | 5–10s | 20–60s | Interpreter and virtualenv resolution are common failure points  [oligo](https://www.oligo.security/academy/static-code-analysis) |
| Go | 10–20s | 3–8s | 20–45s | Usually predictable once module metadata is healthy  [oligo](https://www.oligo.security/academy/static-code-analysis) |
| Rust | 20–40s | 5–15s | 30–120s | Macro expansion and crate graph work can be expensive  [oligo](https://www.oligo.security/academy/static-code-analysis) |
| Java / JVM | 30–60s | 5–15s | 60–120s | Project-model and build-system setup can be heavy  [oligo](https://www.oligo.security/academy/static-code-analysis) |

These are starting budgets, not hard truths. Code-Spider should make them configurable and should allow `doctor` to recommend overrides based on observed repo behavior. [pvs-studio](https://pvs-studio.com/en/docs/manual/0024/)

### Language-specific sandbox policy

Per-language sandbox behavior should differ mainly where ecosystem tooling requires access to local caches or environment-specific metadata. The baseline remains the same—repo-only read, Code-Spider-only write, network off—but some analyzers need carefully scoped additional read access. [code.claude](https://code.claude.com/docs/en/sandboxing)

Recommended language-specific adjustments:

- TypeScript / JavaScript: allow read access to repo-local `node_modules` when present; do not allow arbitrary writes to dependency trees. [mintlify](https://mintlify.com/Glass-HQ/Glass/development/navigation)
- Python: allow optional read access to the active virtualenv or interpreter-resolved environment paths only if the user explicitly enables semantic mode and `doctor` confirms the environment is coherent. [snyk](https://snyk.io/blog/10-dimensions-of-python-static-analysis/)
- Go: allow read access to module metadata and local module cache only when required, with network still disabled unless explicitly approved. [developer.nvidia](https://developer.nvidia.com/blog/practical-security-guidance-for-sandboxing-agentic-workflows-and-managing-execution-risk/)
- Rust: allow read access to cargo metadata and local cache as needed, while applying aggressive idle shutdown and tighter concurrency control due to higher analyzer cost. [oligo](https://www.oligo.security/academy/static-code-analysis)
- Java / JVM: allow read access to project and build metadata only after project-model validation, and avoid eager workspace-wide semantic passes by default. [oligo](https://www.oligo.security/academy/static-code-analysis)

These rules keep the security story simple while still respecting real analyzer needs.

### Incremental analysis policy

Whenever an analyzer or static-analysis tool supports incremental or differential operation, Code-Spider should prefer that mode over repeated full-workspace scans. Incremental analysis is a well-established way to reduce scan duration, reduce noise, and keep analysis integrated into normal developer workflows without causing fatigue or unusable latency. [augmentcode](https://www.augmentcode.com/guides/static-code-analysis-best-practices-enterprise)

The policy should be:

- Full structural scan on initial index.
- Incremental structural refresh based on changed files, mtimes, or commit deltas thereafter.
- Semantic enrichment on demand for selected nodes.
- Differential static analysis when only a subset of files changed or when an investigation scope is narrow. [augmentcode](https://www.augmentcode.com/guides/static-code-analysis-best-practices-enterprise)

This allows Code-Spider to scale from small repos to very large ones without requiring full semantic reprocessing on every run. [augmentcode](https://www.augmentcode.com/guides/static-code-analysis-best-practices-enterprise)

### Failure and fallback behavior

Timeouts, analyzer crashes, or sandbox denials must not poison the session. Code-Spider should fail soft: record the event, degrade capability, and continue serving the best available structural or cached semantic information. [microsoft.github](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)

When an analyzer exceeds budget or violates policy, Code-Spider should:

1. Cancel or terminate the request/process if supported. [github](https://github.com/microsoft/language-server-protocol/issues/786)
2. Persist a structured failure record, including analyzer, language, timeout phase, duration, and sandbox reason.
3. Mark the result as `partial`, `timed_out`, `denied`, or `failed` rather than returning a silent empty set


## Success criteria

The product should be considered successful when:

- A user can identify where to start in an unfamiliar repo within a few minutes. [github](https://github.blog/developer-skills/application-development/how-github-engineers-learn-new-codebases/)
- A user can traverse from overview to a specific symbol without losing context. [versions](https://versions.com/interaction/progressive-disclosure-the-art-of-revealing-just-enough/)
- The tool remains useful even without full semantic tooling. [jetbrains](https://www.jetbrains.com/pages/static-code-analysis-guide/linters)
- Semantic tooling, when available, materially improves symbol navigation and trust. [emergentmind](https://www.emergentmind.com/topics/language-server-protocol-lsp)
- The doctor command accurately explains capability gaps and suggested fixes. [github](https://github.com/wp-cli/doctor-command)
- Investigation exports are good enough to share with teammates as onboarding or architecture briefs. [kdnuggets](https://www.kdnuggets.com/7-must-have-tools-for-your-coding-workflow)

## Open questions

- Should run comparisons be automatic or explicit?
  A. Run comparisons should be at the users request that saves the user a cost. but the tool could watch the directory and flag stale areas
- Should flows be first-class indexed nodes in version 1 or derived views only?
  A. first class from the beginning
- Should notes and investigations be per-user only or support future shared sync?
  Per-user, repo local. 
- Should summaries remain deterministic only, or support optional LLM-assisted narration later?
  This tool is intended for dual purpose. First for solo devs, and also for use with claude code, codex, pi.dev.e 

## Final recommendation

The strongest version of Code-Spider is a layered local intelligence system: fast structural map first, SQLite as the source of truth, optional semantic enrichment through existing LSP and analysis tools, and a CLI built around progressive drill-down plus evidence-backed explanation. [versions](https://versions.com/interaction/progressive-disclosure-the-art-of-revealing-just-enough/)

That combination makes the tool practically useful in constrained real-world environments while leaving room for deeper semantic precision when the ecosystem supports it. [en.wikipedia](https://en.wikipedia.org/wiki/Language_Server_Protocol)
