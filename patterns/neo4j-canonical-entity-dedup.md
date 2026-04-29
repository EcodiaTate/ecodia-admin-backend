---
triggers: neo4j-dedup, knowledge-graph-consolidation, neo4j-merge, canonical-entity-merge, embedded-label, kgConsolidationService, exact-name-match, duplicate-nodes, neo4j-cross-label, cortex-memory
---

# Canonical-entity dedup must merge same-name nodes across different labels

Same-name nodes in the Neo4j knowledge graph are almost always the same entity fragmented across different secondary labels. Merge them. Do NOT require `a.name <> b.name` in the exact-name-match dedup strategy - that condition filters out the exact case you want to catch.

## Why this matters

The graph's utility for session memory (semantic retrieval, relevant-memory injection into user messages) collapses as canonical entities fragment. If "EcodiaOS" exists as 11 separate nodes under labels System, Project, Organization, Software, Database, Platform, AI_System, Component, etc., a search for EcodiaOS returns 11 partial neighborhoods instead of one consolidated node with the full relationship set.

Observed Apr 21 2026 on the live graph:
- "Factory session" x12
- "EcodiaOS" x11
- "Factory auto-deployment gate" x10
- "Neo4j" x10, "Vercel" x9, "Database" x9, "Cortex" x7, "GitHub" x7
- 9457 total nodes, 9128 with the `__Embedded__` label (96%)

The consolidation worker runs every cycle (last run completed 13:08 UTC Apr 21) and includes a `deduplicate` phase, but merges near-zero canonical entities because:

1. Strategy 1 (exact-name-match) has `AND a.name <> b.name` in its WHERE clause. `elementId(a) < elementId(b)` already prevents self-match. The `name <> name` condition then excludes identical names, which is exactly what the strategy is supposed to catch.
2. The loop iterates one label at a time (`MATCH (a:Label), (b:Label)`). Canonical entities live under DIFFERENT typed labels even when the name is identical. The one label they all share is `__Embedded__`, but the loop explicitly skips `__Embedded__` (see line 97, 121).

Net effect: Strategy 1 only catches case/whitespace-variant name dupes under a single type label. It never catches `EcodiaOS:Project` vs `EcodiaOS:System`.

## The rule

Exact-name match is the strongest dedup signal. When two nodes share `toLower(trim(name))` and also share the `__Embedded__` marker (or any other canonical anchor), merge them regardless of their secondary typed labels.

## Do

- Treat exact-name matches on `__Embedded__` nodes as automatic merge candidates, cross-label.
- Keep the `elementId(a) < elementId(b)` ordering to prevent self-match.
- Preserve both nodes' typed labels on the kept node (UNION of labels), so the merged entity still satisfies queries like `:Project` and `:System`.
- Before a cross-label merge, guard against legitimate namespace collisions (e.g. two different things that happen to share a display name). If the typed labels are from incompatible domains, skip or flag instead of merging.
- Run a first-pass in dryRun mode on any logic change, eyeball the would_merge list, then enable live.

## Do NOT

- Do NOT add `AND a.name <> b.name` to an exact-name strategy. That inverts the semantic.
- Do NOT merge across the lowercase/Proper-case label pairs (`decision`/`Decision`, `thought`, `observation`, `realization`) by name alone without also checking content - those legacy lowercase labels may point to different schemas.
- Do NOT delete the `Embedded` (single-underscore-free) label globally in one pass. Some consumer code may still reference it. Phase it out only after grepping the codebase.

## Protocol when fixing dedup logic

1. Grep `src/services/kgConsolidationService.js` for the dedup function. Confirm the `a.name <> b.name` clause is present.
2. Remove the `a.name <> b.name` clause from the exact-name strategy.
3. Add a cross-label pass inside the exact-name strategy: match `(a:__Embedded__)` and `(b:__Embedded__)` with `elementId(a) < elementId(b)` and `toLower(trim(a.name)) = toLower(trim(b.name))`. Return the pair with union of their typed labels. Merge.
4. Preserve labels on merge: `SET keep:$newLabel` for each label from the dupe that keep doesn't already have.
5. Run in dryRun on the whole graph, review the output, then enable live with `KG_DEDUP_SIMILARITY_THRESHOLD` held at 0.90.
6. After first live run, expect dramatic drop in total nodes (easily 20%+ reduction just from the top 25 duplicate entities).

## Verification after deploy

```cypher
MATCH (n) WHERE n.name IS NOT NULL
WITH n.name AS name, count(*) AS cnt
WHERE cnt > 1
RETURN name, cnt ORDER BY cnt DESC LIMIT 25
```

Top entities should drop to cnt = 1 or 2 max. If "EcodiaOS" still shows as 11 nodes, the cross-label pass didn't run or didn't match.

## Origin

Apr 21 2026, autonomous overnight session. Tate directed: "neo4j stuff for you" after locking Co-Exist in. Orientation query showed canonical entities fragmented 7-12x across secondary labels. Reading kgConsolidationService.js lines 85-112 revealed the `a.name <> b.name` guard plus the per-label loop skipping `__Embedded__`. Fix dispatched via Factory. This pattern captures the general rule so future changes to the consolidation logic do not reintroduce the inverted-guard bug.
