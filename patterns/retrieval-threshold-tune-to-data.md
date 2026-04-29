---
triggers: retrieval-threshold, semantic-search-tuning, vector-search, min-score, relevant-memory-injection, cold-start-warmup, retrieval-telemetry, graphrag, cortex-memory, node_embeddings, threshold-default
---

# Tune retrieval thresholds to the actual corpus, not to a default number

Default cosine-similarity thresholds (0.75, 0.78, 0.80) are not universal constants. They reflect an assumption about the text distribution in the corpus being retrieved from. Before asserting any retrieval threshold is "working" or "not working", probe the corpus with realistic queries and read the score distribution. The right threshold is whatever includes the top relevant results and excludes the noise, measured empirically.

## Why this matters

A retrieval layer that silently returns nothing is the worst failure mode - worse than a crash. With a crash you know to fix it. With silent zero-hits the read side is effectively disabled, every turn passes unaugmented, and the LLM runs on stale context. This is how "I shipped a retrieval feature last week" becomes "I've been running without memory for a month." It happened here: `<relevant_memory>` injection shipped 2026-04-20 (commit 0335194) with min-score 0.78. When probed 2026-04-21, the actual relevant top-k scored 0.70 to 0.76 across three realistic query shapes. The 0.78 bar excluded every signal hit.

The right mental model is: cosine similarity between two `text-embedding-3-small` vectors depends heavily on text length, domain vocabulary overlap, and how much of the vector is carrying topic signal vs syntactic filler. For a graph corpus of short descriptions (typical Pattern/Decision names) the natural top-k distribution skews lower than for long paragraphs. 0.78 is tuned for document retrieval, not short-phrase graph nodes.

## Do

- Before shipping or tuning any retrieval threshold, write a probe script that runs the actual semanticSearch function with 3-5 realistic query shapes from recent user messages, at both the current threshold and a loose threshold (0.50). Log the top-5 results per query with exact scores.
- Read the score distribution. The right threshold is the boundary between "genuinely relevant" and "tangentially related." Typical for this corpus as of 2026-04-21: 0.68 to 0.72.
- Add success-path telemetry - log hit count per invocation even on zero hits. Silent success is indistinguishable from silent failure in a grep.
- Do a warmup query at service startup (e.g. in server.js init) so the first user-turn retrieval does not pay the cold driver init cost. Expected cold first-query: 2000-2500ms. Warm: 600-900ms.
- Re-probe quarterly or when the corpus grows significantly. The right threshold drifts as the node population changes.

## Do NOT

- Do NOT assume a retrieval default (0.75, 0.78, industry standard blog post number) is right for your corpus without probing.
- Do NOT conclude "retrieval is broken" from a log grep that finds no success entries. If the function only logs failures, you cannot distinguish silent null from silent firing.
- Do NOT set an outer timeout tighter than the realistic cold-start p99. The first call after a process restart is systematically slower than steady-state.
- Do NOT assume the label whitelist is complete. Nodes written with labels outside the whitelist are invisible to retrieval no matter how good their embedding. Re-audit label coverage when new node types are introduced.

## Protocol when diagnosing a retrieval layer

1. Is the code path actually invoked? Add a log line at entry (not just at error) to confirm invocation count per user turn.
2. Is the corpus being indexed? `CALL db.index.vector.queryNodes('<index_name>', 1, <any vector>)` - if zero results, the index is empty or misnamed.
3. What does the score distribution look like for realistic queries? Run the probe script at loose threshold (0.50) and read the top-10 per query.
4. What labels are in the whitelist vs what labels exist? `CALL db.labels()` vs the whitelist constant. If useful labels are excluded, widen.
5. Does the outer timeout allow cold-start? Time the first call after a fresh process. If it exceeds the timeout, extend timeout or add warmup.
6. Only after all five checks, decide whether the threshold, the labels, the embeddings, or the calling code needs fixing.

## Origin

Apr 21 2026, autonomous overnight session. After speculating in a reflection that "relevant_memory injection has zero hits in 24h" based on a log grep, I wrote a direct probe that imported `src/services/neo4jRetrieval.js` and called `semanticSearch` with three realistic query shapes. Verified results: 0 hits at 0.78 across all three queries, 2-4 hits at 0.50 with max scores 0.729-0.757. The injection was firing but returning null every turn because nothing cleared 0.78. Separate finding: first post-restart query took 2449ms, exceeding the outer Promise.race 2000ms timeout in `_injectRelevantMemory` - so the first retrieval after any pm2 restart failed silently with "neo4j retrieval timeout" caught by the try/catch. Fix landed as commit 053510a (threshold 0.70, widened label whitelist, telemetry, startup warmup). This pattern captures the general rule so future retrieval work starts with empirical probing instead of default inheritance.

Companion: `patterns/verify-before-asserting-in-durable-memory.md` covers the broader rule (never assert counts/absences in a durable memory node without primary-source verification). This pattern is the narrower retrieval-tuning case.
