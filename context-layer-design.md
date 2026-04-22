# Context Layer Design

## Goal

Extend `code-spider` with a curated context layer that improves investigation and discovery without turning the tool into a noisy text dump.

The context layer should answer different questions from different sources:

- code: what exists now
- git: what changed, when, and often why
- beads: what is active, planned, blocked, or deferred
- markdown: what narrative or rationale the project has about itself

The design goal is selective, explainable context. Not total recall.

## Product Principle

`code-spider` should ingest context only when it helps explain, rank, or investigate the code graph.

That implies:

- code remains primary
- context attaches to code nodes through explicit or high-confidence links
- low-signal context is filtered out early
- every surfaced context item should have an explanation for why it is linked

## The Four Lenses

### 1. Code

Source of truth for:

- repo structure
- zones
- units
- atoms
- semantic symbols
- defs
- refs

Questions answered:

- what exists
- where should I read next
- what symbols are in this file

### 2. Git

Execution history.

Source of truth for:

- what changed
- co-change relationships
- recency and activity
- commit-message rationale
- temporal sequence

Questions answered:

- what changed together
- what became important recently
- what was likely being worked on when this file changed

### 3. Beads

Project intent and status.

Source of truth for:

- active work
- planned work
- blocked work
- dependencies between tasks
- current and near-future relevance

Questions answered:

- what is in progress
- what matters next
- what files or subsystems are implicated by current work

### 4. Markdown

Narrative context.

Source of truth for:

- project explanations
- architecture notes
- PRDs and specs
- runbooks
- ADRs
- design rationale

Questions answered:

- what the system is supposed to do
- what the project says matters
- how implementation connects to written intent

## Trust Model

When sources disagree:

- code wins on what exists now
- git wins on what changed and when
- beads wins on current intent and task state
- markdown wins on narrative and rationale, but not factual runtime truth

This needs to be explicit in the product so we do not treat docs or issue text as equal to code truth.

## Context Model

Keep three layers:

### 1. Code Layer

- `repo`
- `zone`
- `unit`
- `atom`
- semantic symbols

### 2. Context Layer

- `doc`
- `doc_section`
- `issue`
- `commit_summary` or `change_cluster`

### 3. Link Layer

- `documents`
- `mentions`
- `explains`
- `tracked-by`
- `changed-with`
- `related-by-topic`
- `depends-on`

Context nodes should mostly exist to explain or connect code nodes.

## Relevance Tiers

### Tier 1: Explicit Links

These should surface by default.

Examples:

- a markdown section names a file path
- a beads issue explicitly names a file or node
- a commit directly touched a file
- a doc names an exact symbol

### Tier 2: Strong Inferred Links

These should surface when useful, but below explicit links.

Examples:

- strong repeated terminology overlap between a doc section and a code unit
- repeated subsystem language in issue text and file names
- recurring co-change clusters across commits

### Tier 3: Background Context

These should usually stay hidden unless requested.

Examples:

- generic README prose
- old closed beads issues
- weak keyword-only matches
- broad commit history with no strong relationship to the target

Default commands should show Tier 1 and strong Tier 2 only.

## Source-Specific Ingestion

### Markdown Ingestion

What to keep:

- document path
- title
- heading hierarchy
- section text in compact chunks
- bullets
- code fences
- explicit file, node, and command mentions

What to classify:

- README
- spec/PRD
- architecture note
- ADR
- runbook
- investigation note

What to avoid:

- full-document blob retrieval
- duplicated boilerplate
- huge prose sections with no code linkage

Output should be:

- `doc` nodes for files
- `doc_section` nodes for meaningful sections
- explicit `mentions` and `explains` edges into code nodes

### Git Ingestion

What to keep:

- exact touched files
- co-change relationships
- recent commit message snippets
- author concentration or ownership hints
- temporal ordering

What to avoid:

- raw diff indexing by default
- full commit-text ingestion
- merge-commit noise unless it adds signal

Output should be:

- `changed-with` edges between units
- recent rationale snippets as evidence
- possibly lightweight time-series metadata for investigations

### Beads Ingestion

What to keep:

- open issues
- recently closed issues
- issue titles
- issue descriptions
- dependency graph
- explicit file/path/node mentions
- current status

What to avoid:

- dumping all closed historical work into the main ranking path
- weak text-only matches with no code anchor

Output should be:

- `issue` nodes
- `depends-on` edges between issues
- `tracked-by` or `mentions` edges from issues to code nodes

## Ranking Strategy

Context should contribute to ranking, not dominate it.

Recommended weighting:

- exact semantic/code match first
- explicit context links second
- inferred links third

Freshness modifiers:

- open beads issues > recent closed issues > stale closed issues
- recent commits > old commits
- focused doc sections > generic project prose

Context should never dominate:

- hotspot scoring
- zone detection
- base file ranking

Those should remain primarily code and git driven.

## Command Behavior

### `show`

Should answer through all four lenses:

- code:
  - node details
  - stats
  - children
- git:
  - recent rationale snippets
  - recent related changes
- beads:
  - active or recent linked issues
- markdown:
  - top linked doc sections

Output rule:

- concise, highly relevant context only

### `related`

Should use:

- shared semantic symbols
- same zone/subsystem
- shared flow participation
- co-change history
- shared active issue linkage
- shared doc-section linkage

Output rule:

- every related result should list reasons

### `investigate`

This is the highest-value consumer of the context layer.

It should allow investigations to gather:

- code nodes
- doc sections
- issues
- git rationale snippets

Output rule:

- investigations should feel like guided discovery, not grep output

### `export report`

Should synthesize:

- code structure
- recent change history
- active work context
- relevant narrative sections

Output rule:

- short curated explanation, not full dumps

### `doctor`

Should report context enrichers alongside semantic analyzers.

Current behavior:

- markdown enrichment available/observed
- git enrichment available/observed
- beads enrichment available/observed

## Schema Direction

Likely additions:

### New Node Kinds

- `doc`
- `doc_section`
- `issue`
- `commit_summary`

### New Edge Kinds

- `documents`
- `mentions`
- `explains`
- `tracked-by`
- `changed-with`
- `related-by-topic`
- `depends-on`

### Evidence Metadata

Additional evidence metadata should include:

- source type
- freshness
- confidence
- explicit vs inferred

## Recommended Rollout

### Phase 1: Markdown Context

Implement:

- markdown parsing
- section extraction
- document classification
- explicit file/path mentions
- doc-section links into code nodes

User-facing impact:

- `show`
- `related`
- `investigate`

### Phase 2: Git Context

Implement:

- co-change edges
- recent rationale snippets
- simple timeline support

User-facing impact:

- `show`
- `related`
- hotspot explanation
- investigations

### Phase 3: Beads Context

Implement:

- issue nodes
- dependency links
- issue-to-code links from explicit references
- freshness and status weighting

User-facing impact:

- `show`
- `related`
- `investigate`

### Phase 4: Investigation Integration

Implement:

- investigations that can collect context nodes directly
- investigation summaries that synthesize code + context

### Phase 5: Reporting

Implement:

- richer `export report` output using curated context

## Guardrails

Do not:

- index all markdown as generic text chunks
- dump raw git history into retrieval
- surface all beads text by default
- let docs/issues dominate core ranking
- present weak keyword overlap as meaningful context

Do:

- attach context to code through explicit or high-confidence links
- keep surfaced context short and explainable
- bias toward freshness for git and beads
- bias toward specificity for markdown

## Success Criteria

This will be working if:

- `show unit:...` gives a short, relevant context panel
- `related` gets smarter without getting noisier
- `investigate` can explain code through code, history, intent, and narrative
- markdown, git, and beads each add distinct value
- users are not overwhelmed by irrelevant prose, stale tasks, or raw history

## Next Step

Turn this plan into the next bead batch, in this order:

1. markdown context indexing
2. git contextual enrichment
3. beads issue/context enrichment
4. investigation integration
5. report polish
