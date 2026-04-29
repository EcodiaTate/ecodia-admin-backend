---
triggers: sync, trigger, fan-out, synthetic event, event_impact, push-back, duplicate, sync-back, syncToExcel, syncFromExcel, reverse-sync, alias, collective alias, sheet sync, excel-sync
---

# Sync-back paths must filter rows that originated from the source they would push back to

## The rule

When you have a bidirectional sync (source ↔ DB) and a write to one side fires a sync-back trigger to the other, the sync-back path MUST filter out rows that originated from the destination it would push back to. Otherwise:

1. From-source-to-DB syncs N rows.
2. Each DB row write fires the sync-back trigger.
3. Each sync-back call attempts to push the row back to source.
4. If any normalisation (collective alias, name canonicalisation, date formatting) makes the back-pushed signature differ from the source row's signature, the dedup catch fails.
5. Result: N duplicate rows on the source side.

Even if dedup catches it perfectly, you've doubled the trigger fan-out cost for zero gain.

## Why

Forms-canonical events on the Co-Exist Master Impact Sheet are reverse-synced into Supabase as synthetic events (`created_by IS NULL`, deterministic UUIDv5 from `forms-{integer_id}`). When the alias map resolves sheet "Melbourne City" → DB "Melbourne", the synthetic event's `collective_name` is "Melbourne". The trigger `excel_sync_on_event_impact` then fires `syncToExcel(event_id=...)` which:

- Reads sheet's existing Forms rows
- Builds dedup signature from sheet using "Melbourne City" (the sheet's actual name)
- Computes the new row's signature using "Melbourne" (DB's canonical name)
- Signatures don't match → APPEND a new UUID row to sheet

Result: from-excel sync of N alias-mapped sheet rows produces up to N spurious UUID duplicates on the sheet. (Race conditions during parallel append calls truncate this further but the bug is structural.)

## Do

- In the sync-back path, pre-fetch the originating-side flag for all candidate rows and skip those that came from the source.
- For Co-Exist specifically: skip events with `created_by IS NULL` in `syncToExcel` (synthetic events came from sheet).
- Allow test-prefix events to bypass the filter so E2E test flows still work.
- Document the guard in code with a clear comment naming the failure mode it prevents.

## Do not

- Rely on the dedup signature alone to catch back-pushed-then-aliased rows. Dedup is computed against the source's actual values, not the canonical values your sync-back produces.
- Filter at the trigger level only. Triggers can fire for many reasons; the filter should be in the sync-back logic so it covers every entry path.
- Skip the test-prefix events along with synthetic events. E2E testing relies on the bypass.

## Protocol when applying

For any data-flow with a write-trigger that pushes to a sibling source:

1. Identify the originating-side flag: a column or convention that distinguishes "this row came from the source I'd push back to" from "this row came from elsewhere."
2. In the sync-back path's main loop, fetch that flag for every candidate row.
3. Skip rows where the flag indicates source-origination, except for explicit test/dev rows.
4. Add a heartbeat metric counting `skipped_synthetic` so you can confirm the guard is working.
5. After deploy, run the source→DB sync once and verify the source side is unchanged (idempotency).

## Do NOT confuse with...

- Strict dedup signature (`(collective, date, title)` lowercased+trimmed): operates on the values BOTH sides see. This catches genuine cross-system collisions like "leader logged the same event on Forms AND in app." It does NOT catch the back-push case because the back-pushed signature uses canonical (post-alias) values that differ from the source's display values.
- Migration gate (`forms_migrated_at`): operates on which collectives have cut over. Doesn't apply to per-event_id sync-back calls (the migration filter is bypassed when `event_id` is supplied).

## Origin

2026-04-29 AEST. Fork `fork_moj9i4qs_44e5b2` shipped Co-Exist alias map (Melbourne City + Byron Bay) and observed 3 spurious UUID rows append to the Master Impact Data Sheet within seconds of the first from-excel run. Investigation: chain-fired to-excel calls (one per event_impact INSERT) computed new-row signatures using canonical collective names (Melbourne), which didn't match Forms-row signatures using sheet names (Melbourne City). Fix: synthetic-event guard in `syncToExcel` skips events with `created_by IS NULL` (and not test-prefix). v19 deployed and idempotency verified (288→288 rows on second from-excel run).

## Cross-references

- `~/ecodiaos/patterns/excel-sync-collectives-migration.md` (architecture invariant)
- `~/ecodiaos/patterns/enumerate-all-trigger-paths-when-fixing-data-flow-bugs.md` (the gate at latest-common-table is correct - this is the producer-side complement)
- `~/ecodiaos/patterns/listener-pipeline-needs-five-layer-verification.md` (excel_sync_runs heartbeat is the layer-5 evidence for catching dark-window failures like the 7-day jobid 9 outage)
- Audit: `~/ecodiaos/drafts/coexist-sheet-db-audit-2026-04-29.md`
- PR: https://github.com/EcodiaTate/coexist/pull/12
