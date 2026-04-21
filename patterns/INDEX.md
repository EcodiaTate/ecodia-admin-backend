# Pattern Surfacing Index

This directory contains durable operational patterns learned from production. Each pattern is a standalone file with a YAML-ish front-matter `triggers:` field listing the contexts in which it should surface.

## How this works (the surfacing mechanism)

**The rule lives in `~/ecodiaos/CLAUDE.md` (Technical Operations Manual):**
Before any high-leverage action, `Grep` this directory for matching triggers. Specifically, before:

- Touching pg_cron jobs on any Supabase project (client or our own)
- Deploying an Edge Function
- Dispatching a Factory session against a client codebase
- Running a data-mutating integration (sync, migration, import)
- Sending a client-facing email that is not a trivial response
- Making a commercial commitment (pricing, scope, IP, termination)
- Building or shipping an iOS/Android binary (signing, upload, release)

Grep command: `Grep triggers: ~/ecodiaos/patterns/ -A 1` - returns each pattern's title + triggers so you can pick which to read in full.

## Pattern files (one per .md)

| File | Triggers |
|---|---|
| [excel-sync-collectives-migration.md](excel-sync-collectives-migration.md) | coexist, excel-sync, forms-migrated-at, dedup, collective-migration, sheet-sync, forms-to-app-migration |
| [edge-function-safe-defaults.md](edge-function-safe-defaults.md) | edge-function, supabase, default-param, missing-param, write-endpoint, mutation, idempotency, deno-serve |
| [ios-signing-credential-paths.md](ios-signing-credential-paths.md) | ios, xcodebuild, code-signing, provisioning-profile, app-store, asc-api-key, testflight, mac, sy094, exportarchive, manual-signing |
| [factory-phantom-session-no-commit.md](factory-phantom-session-no-commit.md) | factory, factory-dispatch, cc-session, approve-deploy, phantom-session, files-changed, commit-sha-null, deploy-status-deployed, ecodiaos-backend, worktree-drift, deliverable-verification |
| [mcp-array-param-bypass.md](mcp-array-param-bypass.md) | mcp, mcp-server, array-param, stringified, invalid-type-expected-array, invalid-type-expected-number, zernio, zernio-create-post, zod-validation, bypass-to-http, direct-api, mcp-harness-bug |
| [no-client-contact-without-tate-goahead.md](no-client-contact-without-tate-goahead.md) | client email, client comms, reply to client, ekerner, eugene, craige, ordit, fireauditors, vikki, angelica, coexist, landcare, resonaverde, client, external contact, forwarded from tate |
| [never-contact-eugene-directly.md](never-contact-eugene-directly.md) | eugene, ekerner, ordit, fireauditors, craige, PR 212, ordit review, ordit comms (superseded in scope by no-client-contact-without-tate-goahead) |
| [neo4j-canonical-entity-dedup.md](neo4j-canonical-entity-dedup.md) | neo4j, knowledge-graph, kg, consolidation, dedup, deduplicate, merge, canonical-entity, embedded-label, kgConsolidationService, exact-name-match, duplicate-nodes, cross-label, cortex-memory |
| [verify-before-asserting-in-durable-memory.md](verify-before-asserting-in-durable-memory.md) | neo4j, graph_reflect, reflection, episode, durable-memory, cold-start, speculation, assertion, zero-count, null-count, kv_store-handoff, memory-integrity |
| [retrieval-threshold-tune-to-data.md](retrieval-threshold-tune-to-data.md) | neo4j, retrieval, semantic-search, vector-search, threshold, min-score, relevant-memory, injection, embedding, cold-start-warmup, telemetry, graphrag, cortex-memory, node_embeddings |

## Authoring rules

- **One file per pattern.** Don't bundle.
- **Front-matter `triggers:` is grep-targetable.** Use hyphenated lowercase keywords, comma-separated.
- **Lead with the rule in one sentence.** Then the rationale, then the concrete protocol, then the origin event.
- **Never include an em-dash.** Hyphen + spaces or restructure.
- **Split doctrine from event.** If a pattern is derived from an event, the event goes into the `Origin` section. The rule at the top is generic and reusable.

## When to add a new pattern

Trigger thresholds (any one of these means "write a pattern"):
1. A failure cost non-trivial time or trust in the last 24h.
2. The same mistake has been made twice in different contexts.
3. An architectural decision that future-you would reasonably re-litigate.
4. A domain-specific lesson that generalises beyond the immediate client.

If the lesson is ONLY event-specific (no generic rule), write it as a Neo4j Episode instead, not a pattern.

## Maintenance

- When a pattern becomes outdated (system changed, tool replaced), delete it. Stale patterns are worse than no patterns.
- If you find two patterns saying the same thing, merge them.
- This INDEX.md must list every file in the directory. If it falls out of sync, fix it.
