# LSP Ref Edges Design

Date: 2026-06-22
Bead: code-spider-kvr

## Goal

Wire LSP reference-query results into the file-level relationship graph so that the `related` command surfaces cross-file dependencies discovered by the language server — not just co-change and doc signals.

## Problem

LSP ref queries already run during indexing (`populateSymbolEdges` in `semantic-enricher.ts`) and write symbol→symbol edges into `symbol_edges` with `kind='references'`. However, `related` reads from the `edges` table (unit→unit), so these results are invisible to it. The gap is a granularity mismatch: symbol-level data never gets aggregated up to file-level.

## Architecture

Two targeted changes, no schema changes:

1. **`src/services/semantic-enricher.ts`** — new `deriveUnitRefEdges()` function called after `populateSymbolEdges()`. Aggregates cross-file rows from `symbol_edges` into file-level `edges` with `kind='lsp-refs'`.

2. **`src/services/related.ts`** — new signal query reads `edges.kind='lsp-refs'` (both directions) and folds into the aggregate score. Not exposed as a `--kind` option.

## Data Flow

```
LSP ref queries → symbol_edges (kind='references', symbol→symbol)
    ↓ deriveUnitRefEdges() [new, runs after populateSymbolEdges]
edges (kind='lsp-refs', unit→unit, weight=cross-ref count)
    ↓ RelatedService lsp-refs signal [new]
related aggregate score
```

## Edge Derivation (`deriveUnitRefEdges`)

Runs immediately after `populateSymbolEdges` returns. Single SQL query:

```sql
SELECT s1.node_id AS from_node, s2.node_id AS to_node, COUNT(*) AS ref_count
FROM symbol_edges se
JOIN symbols s1 ON se.from_symbol_id = s1.id
JOIN symbols s2 ON se.to_symbol_id = s2.id
WHERE se.run_id = ? AND se.kind = 'references' AND s1.node_id != s2.node_id
GROUP BY s1.node_id, s2.node_id
```

Each result row inserts one edge:

```sql
INSERT INTO edges (run_id, from_node_id, to_node_id, kind, weight, confidence, metadata_json)
VALUES (?, ?, ?, 'lsp-refs', ?, 1, NULL)
```

- `weight` = `ref_count` (number of cross-file symbol references between this pair)
- `confidence` = 1 (LSP refs are authoritative)
- Self-references excluded by `s1.node_id != s2.node_id`
- Returns count of edges written for logging
- Fail-soft: empty `symbol_edges` → 0 edges written, no error

## Related Signal

New signal added to `RelatedService`. Reads both directions (caller and callee are both related):

```sql
SELECT
  CASE WHEN e.from_node_id = :nodeId THEN e.to_node_id ELSE e.from_node_id END AS related_node_id,
  SUM(e.weight) AS ref_count
FROM edges e
WHERE e.run_id = :runId
  AND e.kind = 'lsp-refs'
  AND (e.from_node_id = :nodeId OR e.to_node_id = :nodeId)
GROUP BY related_node_id
```

- Score multiplier: `ref_count * 1.0` (below `changed-with` at 1.5× — ref density is more granular)
- Signal reason label: `"lsp refs"`
- Folded into aggregate score; not exposed as a `--kind` filter option

## Testing

**`deriveUnitRefEdges` unit tests** (new file or added to `semantic-enricher.test.ts`):
- Two files with cross-file symbol refs → one `lsp-refs` edge with correct weight
- Multiple refs between same pair → single edge, weight = total count
- Same-file refs → no edge written
- No LSP data (empty `symbol_edges`) → zero edges, no error

**`RelatedService` signal tests** (added to existing related tests):
- Node with `lsp-refs` edges appears in related results
- Score reflects ref count at 1.0× multiplier
- Both from-direction and to-direction surface the related node

## Constraints

- No schema changes — `lsp-refs` is a new value in `edges.kind` (TEXT), not a new column
- Fail-soft: zero LSP data → zero edges, no crash
- `deriveUnitRefEdges` must run after `populateSymbolEdges` and before the semantic enricher returns
- `related --kind` filter options unchanged — signal is aggregate-only
