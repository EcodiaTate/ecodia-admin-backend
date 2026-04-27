---
triggers: factory-low-confidence, factory-confidence-0.4, critical-path, kv_store-accessor, sessionHandoff, auth-flow, scheduler, mock-vs-production, test-mock-hides-bug, jsonb-vs-text, postgres-type-mismatch, second-attempt-fix, cold-start-recovery, factory-quality-gate, audit-window
---

# Audit low-confidence Factory commits within 24h on critical-path files

## Rule

When Factory ships a commit at `confidence_score < 0.5` against a critical-path file, schedule an audit pass within 24h. The audit looks for failure modes the existing tests cannot catch, particularly **mock-vs-production database-type mismatches**, before the unit-test suite cements the false-positive and the bug becomes invisible.

Confidence < 0.5 is Factory's own admission that something is uncertain. Combined with a critical-path file, that uncertainty must not get buried under a green test run.

## Critical-path files

- Cold-start recovery: `sessionHandoff.js`, `sessionAutoWake.js`
- Auth flows: OAuth callbacks, token refresh, credential resolution
- Data integrity: `kv_store` accessors, ledger writers, `status_board` mutators
- Scheduler: `schedulerPollerService`, `factoryRunner`
- The OS harness: `osSessionService.js`, `messageQueue.js`

If the modified file or any file it imports is on this list, the audit is mandatory.

## The audit

1. Query `cc_sessions WHERE confidence_score < 0.5 AND status = 'deployed' AND deployed_at > NOW() - INTERVAL '7 days'`. Identify modified files.
2. For each critical-path hit, read the test file alongside the prod file.
3. Verify the test mock simulates the **exact** production database column types: TEXT vs JSONB, INT vs BIGINT, NULL semantics, timestamp vs timestamptz.
4. Run a **live DB smoke test** that exercises the actual SQL path the prod code uses against the real Supabase instance. Not the mock.
5. If the mock disagrees with production schema, the test is a false-positive: write a new integration test against the real schema, dispatch a fix, escalate the original commit for review.

## Do

- Schedule the audit at deploy-time, not retrospectively. The deploy hook can fire a `schedule_delayed in 12h` checkpoint when confidence < 0.5 + critical-path file detected.
- For any `kv_store` accessor: confirm `db_describe_table` shows the actual column types. The mock should reflect them.
- For Postgres `->>` operator: it works on JSONB only. On TEXT, cast `value::jsonb->>'key'` or do the JSON parse in JS.
- Use the second-attempt prompt template that explicitly mandates a TEXT-column-aware test (or whatever the actual production schema is) so the regression test catches the same class of bug.

## Do not

- Assume green tests + Factory deploy = working code when confidence was < 0.5.
- Approve future low-confidence deploys against critical-path files without an integration test in the same dispatch.
- Let mocks that abstract away DB-type behaviour pass review. A mock that always parses values as JS objects when the real column is TEXT is hiding production bugs by construction.

## Verification step for kv_store-touching code

Before approving any Factory deploy that touches `kv_store`:

```sql
-- Confirm column types
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'kv_store';
-- Expect: key TEXT, value TEXT, updated_at timestamptz

-- Verify the WHERE-clause SQL the prod code uses runs against real data
-- Substitute the actual key the prod code targets
SELECT key FROM kv_store WHERE key = '<the_key>' AND <the_actual_where_predicate>;
```

If this surfaces `operator does not exist: text ->> unknown`, the prod code is broken regardless of what the unit tests say.

## Origin

2026-04-28 07:05-07:30 AEST. Self-evolution rotation A.

Factory commit `e5f1030` (Apr 27 17:14 UTC, confidence 0.42) introduced consume-vs-peek separation in `src/services/sessionHandoff.js` to bridge the Apr 11-12 overnight-session-drop failure. The commit shipped with a latent Postgres type-mismatch bug:

```js
// kv_store.value is TEXT, but the WHERE clause uses ->> directly:
WHERE (value->>'consumed_at' IS NULL OR ...)
// Postgres error: operator does not exist: text ->> unknown
```

Caught by the function's outer try/catch, the error logged a warning and returned null. The unit test passed green because the mock parsed `value` as a JS object, simulating JSONB and hiding the production failure. Every cold-start `consumeHandoffState()` call has silently null-ed the recovery block since the commit deployed.

The bug went undetected for ~14 hours. Discovered during a self-evolution audit specifically targeting recent Factory commits at confidence < 0.5 against critical-path files. Episode 3235 captures the discovery walk; this Pattern is the doctrine extracted from it. Second-attempt fix in flight as Factory session `76d960a9-33e7-44ac-941f-9ed6ad570f5f` with a TEXT-column-aware test as the regression gate.

## See also

- `factory-quality-gate-over-cron-mandate.md` - dispatch-time quality gate (this pattern extends it post-deploy)
- `factory-phantom-session-no-commit.md` - mode-1 phantom (the deploy looks shipped but is not real)
- `factory-metadata-trust-filesystem.md` - verify-not-shipped at filesystem level
- `verify-before-asserting-in-durable-memory.md` - same anti-pattern in Neo4j writes
