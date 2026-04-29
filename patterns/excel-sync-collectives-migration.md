---
triggers: excel-sync, forms-migrated-at, coexist-collective-migration, coexist-sheet-sync, coexist-forms-to-app-migration, forms_migrated_at
---

# Co-Exist Forms → App migration: `forms_migrated_at` is the only switch, and it is explicit per-collective

## The rule

The Co-Exist app is replacing Microsoft Forms as the primary event-logging interface, but the SharePoint "Master Impact Data Sheet" is the shared artefact and stays the source of truth during transition. The migration is per-collective, not global. Flipping any collective from Forms-canonical to app-canonical is a production data-flow change that requires explicit client sign-off.

The entire migration is controlled by one column: `public.collectives.forms_migrated_at timestamptz`.

- `NULL` = that collective still uses Forms. App-submitted events for this collective are NOT written to the sheet (to-excel skips them). The sheet reflects Forms-only reality.
- `<timestamp>` = that collective has cut over. Any app event for this collective with `date_start >= forms_migrated_at` flows to the sheet on the next to-excel run. Events before that date are still Forms-canonical and are skipped.

Test-prefixed titles (`title ILIKE 'test%'`) always flow regardless of collective state. This is for E2E testing and must not be repurposed.

## Why this matters

If you flip `forms_migrated_at` on a collective prematurely:
- Any pre-cutover app events for that collective that have been sitting in DB "drafts" suddenly flood onto the sheet on the next to-excel run (every hour on the hour, jobid 10).
- If the leader has also submitted the Forms version (likely during transition), you get duplicate rows on the sheet. The dedup safety net catches case-(collective, date, title) matches but only against the integer-ID Forms rows that are ALREADY on the sheet at the time of the run. An app event that beats the Forms submission to the sheet is not caught.
- Undoing this is manual row-deletion on the client's live spreadsheet. Reputation cost.

If you flip it too late: leaders log events in the app expecting them to appear on the sheet, nothing happens, and they lose trust in the app.

## Protocol

**Default state:** `forms_migrated_at IS NULL` on every collective. Keep it that way until the client explicitly signs off on cutover for a specific collective.

**Before flipping `forms_migrated_at` on a collective:**
1. Confirm written client sign-off (Kurt, or a forwarded instruction from Kurt). Not "I think we talked about it."
2. Confirm the leader of that collective has been told to stop submitting the Microsoft Form. If they do both during transition, you will get collisions.
3. Verify the dedup signature set is healthy: run from-excel first to refresh the in-memory signature set, then run to-excel with a small test event to confirm the skip logic fires.
4. Pick a `forms_migrated_at` value that is STRICTLY AFTER the last Forms submission for that collective. Do not set it to a date where both Forms and app events might exist.
5. Record the flip in the `coexist.md` client file under "Lessons Learned" with: collective name, date flipped, rationale, who signed off.

**Verifying a flip is working:**
```sql
-- Check current state
SELECT id, name, forms_migrated_at FROM collectives ORDER BY name;

-- Events eligible to flow to sheet after the flip
SELECT id, title, date_start, collective_id
FROM events
WHERE status = 'completed'
  AND date_start >= '2026-01-01'
  AND collective_id = '<uuid>'
  AND date_start >= '<forms_migrated_at value>'
ORDER BY date_start;
```

**Rolling back a flip** (if a leader says they're not ready, or you flipped the wrong collective):
```sql
UPDATE collectives SET forms_migrated_at = NULL WHERE id = '<uuid>';
```
Then manually delete any UUID-ID rows from the sheet that were appended in error. The sheet is the source of truth for historical integrity; DB state does not auto-undo sheet rows.

## The dedup safety net (how it protects you)

On every to-excel run, the Edge Function:
1. Reads all rows from the sheet currently.
2. Builds a signature set from rows whose column-A value is a FORMS integer ID only (rows 2-256, plus any future Forms rows).
3. Signature = `collective.trim.lower + '|' + date_yyyy_mm_dd + '|' + title.trim.lower`.
4. For each candidate app event, computes the same signature and checks. If it matches, the event is SKIPPED, the counter `skippedDuplicates` increments, and the run returns an explicit error message `Event <id>: skipped (matches Forms row signature <sig>)`.

This is a BELT, not a BRACES. It does not protect against:
- App event + Forms submission for the same event where the app event reaches the sheet FIRST (there was no Forms row to match against).
- App event with a slightly different title than the Forms submission (one word different, typo, etc.). Collisions are signature-based, not fuzzy.
- Two app-submitted events for the same (collective, date, title) (the signatures match between app events too, but we don't check that direction).

The primary defence is `forms_migrated_at` timing. Dedup is the fallback.

## Column mapping (for sheet col integrity)

Array-index 0-based. If you ever see buildExcelRow drifting from these, it is wrong:

- 0: ID (UUID string for app rows, integer for Forms rows)
- 1: Title
- 2: Date (Excel serial number, not ISO string)
- 3: Collective (the collective name - Brisbane, Sunshine Coast, etc.)
- 4: Location
- 5: Postcode
- 6: Primary Organiser of the Event - hardcoded constant `'Co-Exist'` matching Forms convention. Not the collective name. Not the leader. Not blank. `'Co-Exist'`.
- 7-9: Landcare/OzFish flags
- 10: Leader (person)
- 11: Attendees
- 12-27: survey responses + impact metrics

Col 6 has a TODO in code for when partner-org events land via `event_organisations` + `organisations` tables. Until then, constant.

## pg_cron jobs

- jobid 9 (`excel-from-sync`, `*/30 * * * *`): calls `public.cron_excel_from_sync()` → invokes Edge Function with `direction=from-excel`. Pulls sheet → DB for UUID rows' impact fields only; skips integer-ID Forms rows. Reverse-sync of integer-ID Forms rows into events + event_impact landed 2026-04-21 commit dc77ea9 (extended with 23 activity-type mappings + suffix-strip fallback in commit bbfa100).
- jobid 10 (`excel-to-sync-hourly`, `0 * * * *`): calls `public.cron_excel_to_sync()` → invokes Edge Function with `direction=to-excel`. Pushes DB → sheet for events passing the migration gate and not matching the Forms dedup set.

Both procs currently hardcode the legacy JWT service_role key, which works because `excel-sync` does a permissive `authHeader.startsWith('Bearer ')` check. Future pass: migrate to vault lookup for rotation safety.

## Origin

2026-04-21, Excel sync rewrite (commit `e7114f2`). The first architecture proposal was "flip a boolean on every collective simultaneously." Rejected because Co-Exist has regional leaders who adopt tools at different speeds. Second proposal was "date-based cutover with a single global date." Rejected because Brisbane, Sunshine Coast, and future collectives will cut over on their own timelines. Final design: per-collective timestamp with test-prefix bypass and a dedup signature safety net.

Validated end-to-end 2026-04-21 post-deploy: col 6 = 'Co-Exist' on all new UUID rows; col 3 = collective name; dedup caught a forced collision with row 196 (New Farm Park Clean Up, 2026-01-31, Brisbane) and returned `skippedDuplicates: 1` with the explicit error message.

## Follow-up cleanup, same day

Shortly after deploy, Tate flagged "2026 events are still duplicated on the sheet." Investigation via Graph `usedRange` showed 67 UUID rows on the sheet from PRE-v2 runs. Of those:
- 2 were same-day duplicates of Forms rows (row 301 Geelong 2026-03-07 "Barwon River Buckley Falls Nature Hike" vs Forms row 229 "Buckley Falls Nature Walk"; row 308 Brisbane 2026-03-21 "Spotlighting @ Whites Hill Reserve" vs Forms row 232 "Wildlife Spotting Event"). These were signature-safe by string-match (different titles) but semantically the same event.
- 60 were app-only with no Forms row on same (collective, date).
- 5 were test-prefixed (allowed under v2).

Cleanup protocol executed: suspend jobids 9 + 10 → Graph API `DELETE /range(address='A257:AB318')` with `shift:'Up'` (one call, 62 rows, 204 response) → verify 261 rows remain (255 Forms + 5 Test) → resume crons.

**Lesson added to this doctrine:** v2 prevents NEW pollution but does not clean up historical. After any sync-logic change, audit the sheet (pull usedRange, classify UUID rows by signature match against Forms), and purge anything that violates the new rules, within the same session.

**Lesson added re: duplicate detection:** the strict `(collective, date, title)` signature misses real-world duplicates where the leader logged the same event under slightly different names in the two systems. A weaker `(collective, date)` pairing catches these but creates false positives when two genuinely distinct events happen on the same day for the same collective. For audit purposes use the weaker signal; for automated dedup-at-append keep the strict signal. Both rows 301 and 308 above were real semantic duplicates missed by the strict check.

**Lesson added re: audit script indexing:** `buildExcelRow`'s col-6 (Excel column G) is at JS array position 6. Col 5 (F) is postcode. During the cleanup audit I inspected `r[5]` thinking it was the organiser field and saw integer values (postcodes like 4557 Sunshine Coast, 6015 Perth) and briefly concluded col-6 was bugged. The bug was in my audit, not the code. Always verify column mapping with an explicit cell dump before acting on "wrong column" conclusions.

**Lesson added re: leader free-text drift (2026-04-21 post-deploy probe):** the 23-entry mapping extension in commit bbfa100 still leaves ~16 Forms labels falling through to 'other' on from-excel runs. Examples: `"restoration"`, `"conservation"`, `"painting"`, `"invasive species removal"`, `"reef restoration - shellfish mat building"`, `"bee hotel building workshop"`, `"ecosystem restoration (e.g. oyster reef restoration)"`. The suffix-strip fallback only handles `& X` / `and X` tails. Hyphen tails, parenthesised qualifiers, and standalone single-word category labels still miss. Next pass: either (a) token-based fuzzy match (if label CONTAINS "restoration" → ecosystem_restoration), or (b) pre-publish the canonical label list back to Forms so leaders pick from a dropdown. Option (b) is cleaner but requires client action.
