---
triggers: neo4j, graph_reflect, reflection, episode, durable-memory, cold-start, speculation, assertion, zero-count, null-count, kv_store-handoff, memory-integrity
---

# Verify counts and facts before asserting them in a durable memory node

When writing to a durable memory store (Neo4j reflection, Pattern node, kv_store handoff, pattern file), every numeric claim and every "X is empty / X is never populated / X never happens" assertion must be verified with a direct query FIRST. Speculation in a durable node is worse than no memory at all, because a future cold-start session will treat it as ground truth and act on bad data.

## Why this matters

The whole point of the Neo4j / kv_store / pattern-file layer is that a new session, stripped of in-session context, can rehydrate by reading it. If a reflection says "Episode label has 0 nodes, never populated" and the actual count is 55, a cold-start session will either (a) stop writing Episodes because they "don't work", (b) skip Episode-based queries because "nothing's there", or (c) burn tokens re-discovering the truth. All three compound the damage.

Ephemeral in-session speculation is fine - I work through uncertainty constantly. The line is the `graph_reflect` / Pattern-file / save-state call. Anything that lands in a durable store has to be verified or explicitly flagged as unverified.

## Do

- Run the count query (`MATCH (n:Label) RETURN count(n)` or equivalent) BEFORE asserting "0", "empty", "never populated", "always", "none exist".
- Quote the query and its result in the reflection body when the claim is counter-intuitive or zero-valued.
- Mark speculation explicitly when it is speculation: `(unverified - estimated from X)` inline.
- Distinguish "observed pattern" from "tested hypothesis" in the reflection text.
- If a correction is needed after a prior node was wrong, write a new reflection of type `realization` that names the incorrect prior assertion and corrects it. Do NOT silently update the old node; the correction IS the memory.

## Do NOT

- Do NOT assert a count, threshold, or categorical absence from intuition or partial context.
- Do NOT round "seems empty from the logs" to "is empty" in a stored node.
- Do NOT use exclamation marks on numbers you haven't verified ("Episode 0 (!)"). The emphasis amplifies the damage when the number is wrong.
- Do NOT conflate "I didn't see X in the logs I scanned" with "X never fires." Log grep is a sample, not ground truth.
- Do NOT delete a wrong reflection. Correct with a new one so the failure mode is learnable.

## Protocol when the urge arises to assert a numeric or categorical claim in a durable store

1. Ask: is this a count, a threshold, an absence claim, or a "never/always" claim? If yes, stop.
2. Run the direct query (Cypher count, SQL count, grep -c, whatever the primary source is).
3. Paste the query result into the reflection text, or summarize with the exact number.
4. Only then call `graph_reflect` or write the pattern file.
5. If already asserted and later proven wrong: write a `realization` reflection naming the prior error, the corrected value, and the lesson.

## Origin

Apr 21 2026, overnight autonomous session. Investigating why the relevant-memory injection (commit 0335194) was not prepending `<relevant_memory>` blocks to my incoming user messages. I wrote an observation reflection that included the claim "Episode 0 (!) - which means Episode label is never populated". Immediately after, a follow-up query I should have run FIRST showed Episode = 55 nodes. Corrected via a `realization` reflection. The speculation would have misled the next cold-start session that read the observation at face value.

Surfacing rule: any time I'm about to call `graph_reflect`, `saveHandoffState`, or `Write` a pattern file containing a count or "never/always" claim, grep this pattern first.
