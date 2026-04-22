---
triggers: monitoring, observability, telemetry, feature-verification, zero-results, extracted_at, extracted_by, write-time-extraction, tier-4a, tier-4b, tier-4c, kg-extraction, false-alarm, schema-drift, observer-bug, broken-feature, probe-first, neo4j-property-name
---

# Verify the monitoring query schema before declaring a feature broken

When a feature is declared shipped and live but live monitoring returns zero events, the cheapest hypothesis is almost always that the monitoring query is wrong, not that the feature is broken. A broken observer and a broken feature return identical empty result sets, but fixing the observer is free and fixing the feature is expensive.

## Rule

Before writing a bug report, raising a Problem node, or dispatching a Factory fix on the basis of "feature X is silently not firing," prove the feature is broken by probing it directly with a known-good input and reading back the exact schema fields the source code writes. If those fields are populated, the feature is fine and the bug is in your query. If they are not populated, then escalate.

## Protocol

1. Open the source for the feature and identify ONE field it definitely writes on the success path. Do not guess the property name - read it.
2. Run a minimal probe that triggers exactly the code path in question (e.g. one graph_merge_node call, one edge-function invocation, one cron fire via schedule_run_now).
3. Query the store for the exact field from step 1 on the exact record the probe created.
4. If the field is populated, your monitoring query is wrong. Fix the query. The feature is fine.
5. If the field is not populated, THEN proceed with root-cause diagnosis (env vars, subprocess spawn, silent fetch failure, auth, etc).

## Common traps this prevents

- Querying `r.extracted_by IS NOT NULL` when the extractor writes `r.extracted_at`. Zero results look like "feature broken" but are really "wrong predicate."
- Querying `n.created_at` when the ORM writes `n.createdAt` (camelCase vs snake_case drift).
- Querying a log table for a span of 24h when the log retention is 6h.
- Querying the wrong environment entirely (dev DB vs prod DB).
- Checking `os_scheduled_tasks.last_ran_at` when the scheduler writes `completed_at`.

## Do

- Read the source. Write your query against the exact property name the code emits.
- Include a probe write IN the audit. If the audit cannot distinguish "no data" from "wrong predicate," it is not an audit.
- Close false-alarm Problem nodes with an explicit `status: resolved-false-alarm` and a resolution note, so future cold-start reads don't chase a non-existent bug.

## Do not

- Do not infer "feature broken" from zero results alone. Zero is the most ambiguous result set in observability.
- Do not dispatch a Factory fix based on a zero-count query without first running a probe.
- Do not leave an unresolved Problem node titled "X is a silent no-op" in the graph while still investigating - it poisons cold-start reads. Either diagnose to completion in one turn or title the node as a hypothesis not an assertion.

## Origin

Apr 22 2026 16:56 AEST. Queried Neo4j for `MATCH ()-[r]->() WHERE r.extracted_by IS NOT NULL AND r.extracted_at > datetime() - duration('PT12H')` to monitor Tier-4a write-time edge extraction. Got zero rows. Concluded the Tier-4a hook was silently no-opping, opened a Problem node listing four candidate root causes including .env misnaming, subprocess env inheritance, and fetch failures. Ran a live probe (graph_merge_node on the Problem node itself). Within 1 second the node had a `MENTIONS -> Neo4j` edge with `r.extracted_at = 2026-04-22T06:56:49.762Z` populated. Re-ran the corrected query (predicate on `r.extracted_at IS NOT NULL`) and got 13 extracted edges in 24h across 9 MENTIONS, 3 INVOLVES, 1 CAUSED_BY. Tier-4a was fine. The extractor writes `extracted_at`, not `extracted_by`. Closed the Problem node as resolved-false-alarm. Cost: 30 seconds of wasted audit time. Value: the habit, now codified.
