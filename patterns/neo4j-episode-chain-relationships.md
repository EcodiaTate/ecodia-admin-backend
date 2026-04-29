---
triggers: prior_episode, FOLLOWS-relationship, graph_merge_node, graph_create_relationship, neo4j-episode-chain
---

# Neo4j Episodes must chain via :FOLLOWS relationships, not string prior_episode properties alone

## The rule

When you author an `:Episode` node that references a prior Episode (`prior_episode`), you MUST write BOTH:

1. The `prior_episode` property on the new node - as an **integer** (the prior Episode's numeric id) - for human-readable inline context.
2. A `(:Episode)-[:FOLLOWS]->(:Episode)` relationship pointing from the new Episode back to the prior one - for Cypher traversal.

The property alone is not enough. String properties are not traversable in Cypher. `MATCH (e)-[:FOLLOWS*]->(prior)` walks the chain; `MATCH (e) WHERE e.prior_episode = ...` does not.

## Why

Episodes in the EcodiaOS graph form chains of causally-linked decisions (e.g. meta-loop -> triage event -> security audit -> self-evolution). Future cold-start sessions ask questions like:

> "What chain of events led to the PR 212 triage decision on Apr 24?"

Answering that requires walking the chain with a single query:

```cypher
MATCH path = (latest:Episode {name: '...PR 212...'})-[:FOLLOWS*]->(origin:Episode)
RETURN [n IN nodes(path) | n.name] AS chain
```

If the chain lives only in the `prior_episode` string property, this query returns nothing. The knowledge is in the graph but not queryable. Pointless.

## Do

- When calling `graph_merge_node label=Episode`, also call `graph_create_relationship` with `rel_type=FOLLOWS` from the new Episode to the prior Episode in the same turn.
- Store `prior_episode` as an **integer** (`id(prior_ep)` or the numeric suffix of `elementId`), not a quoted string. Mixed types across the chain break filters like `WHERE e.prior_episode = 2217`.
- Use `id(e)` (legacy integer) when matching across today's Episodes - Neo4j elementId strings are format-version dependent and harder to hand-read. The legacy integer is stable within a database.
- Keep chains shallow per session (2-4 Episodes). If a session produces more, the Episodes are probably too granular - consolidate.

## Do not

- Do not write `prior_episode` as a string (e.g. `"2217"`) and consider the link recorded. It is not traversable and it is inconsistent with numeric priors elsewhere.
- Do not skip the relationship under the assumption "the property is enough." It isn't.
- Do not use the `prior_episode` property as the authoritative link. The relationship is authoritative; the property is a convenience.
- Do not create bidirectional `:FOLLOWS` relationships. The direction is new -> prior (the new Episode follows from the prior one). One direction only.

## Protocol when authoring an Episode

```
1. graph_merge_node label=Episode, match_key=name, match_value="...", properties={
     description: "...",
     date: "2026-04-24",
     aest: "13:15",
     prior_episode: <INT id of prior Episode>,
     ...
   }
2. Immediately after: graph_create_relationship
     from_label=Episode, from_match="name: '<new name>'",
     to_label=Episode,   to_match="name: '<prior name>'",
     rel_type=FOLLOWS,
     properties={created_at: datetime(), reason: "<cron name or context>"}
3. Verify: MATCH (e:Episode {name:'<new name>'})-[:FOLLOWS]->(p) RETURN p.name
   - Must return exactly one row.
```

## Backfill for legacy Episodes

If you land in a session where the chain exists only in string `prior_episode` properties, backfill before proceeding:

```cypher
// 1. Normalise string -> int
MATCH (e:Episode) WHERE e.prior_episode IS NOT NULL AND toString(e.prior_episode) = e.prior_episode
SET e.prior_episode = toInteger(e.prior_episode);

// 2. Create :FOLLOWS for every Episode with a prior_episode but no outgoing FOLLOWS
MATCH (e:Episode) WHERE e.prior_episode IS NOT NULL
  AND NOT (e)-[:FOLLOWS]->(:Episode)
MATCH (p:Episode) WHERE id(p) = e.prior_episode
MERGE (e)-[r:FOLLOWS]->(p) ON CREATE SET r.created_at = datetime(), r.reason = 'backfill';
```

## Origin

Apr 24 2026 self-evolution session (~13:01 AEST). Audit of today's Episode chain (2215 self-evolution -> 2216 meta-loop -> 2217 PR 212 triage -> 2218 MCP RCE audit) found the chain referenced in `prior_episode` string properties only. `graph_merge_node` had no mechanism to also write a `:FOLLOWS` edge, so every past Episode-chain has the same gap.

Recorded in Neo4j Episode 2219 (self-evolution-apr-24-13-01-episode-chain-relationships). Backfill applied to today's chain 2215-2218 in the same session. Future Episodes must follow the protocol above.

## Re-trigger conditions

Revisit this doctrine if:
- A session produces Episodes that don't need to chain (standalone events) - clarify that `:FOLLOWS` is only for causally-linked Episodes.
- Neo4j MCP gets a helper tool that writes Episode + FOLLOWS atomically - update the protocol to use it.
- Chain queries become a hot path - consider indexing or materialising chain depth as a property.
