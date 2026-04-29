# Co-Exist sheet ↔ DB sync audit and reconciliation

**Date:** 2026-04-29 AEST
**Fork:** fork_moj9i4qs_44e5b2
**Brief origin:** Tate, 09:23 AEST 29 Apr 2026 - "sort all of this once and for all"
**Scope:** Master Impact Data Sheet (SharePoint) ↔ Co-Exist Supabase DB (project ref `tjutlbzekfouwsiaplbr`)

---

## Headline findings

1. **Root cause of "sheet entries not syncing to DB" + "leader-task gate stuck":** pg_cron **jobid 9 (`excel-from-sync`) has been INACTIVE since 2026-04-21 13:30 UTC** (~7 days dark). It runs every 30 minutes when active; that's ~340 missed runs.
2. **Root cause of duplicates between Forms and app events:** the **Melbourne City and Byron Bay collective alias commit (0bceac5) has not been merged to main** and is not deployed in the live Edge Function. Sheet rows for these collectives don't match any DB collective, get skipped on reverse-sync, and can't link to existing app events via PR #11's matcher.
3. **PR #11 (commit fdaaab9, merged 2026-04-28 23:23 AEST) is correct in code but unobserved in production** because jobid 9 was already paused for 7 days when it merged. Its backfill migration ran successfully (4 historical app events linked), but no NEW Forms submissions have been processed by the v17 Edge Function.

The five inconsistency sets:

| Set | Description | Count | Reconcile |
|---|---|---|---|
| A | Sheet duplicates - weak (collective, date) | 3 groups (1 real semantic, 1 expected test-bypass, 1 cross-system) | Yes |
| B | Sheet Forms rows with no DB event | 9 (8 Melbourne City + 1 Adelaide) | Yes - via jobid 9 resume + alias deploy |
| C | DB events missing event_impact when sheet has data | 0 (after PR #11 backfill) | None needed |
| D | Stuck leader-tasks (impact-form-task gate) | 0 completed; 4 past-date published/draft | Convergent with B+C |
| E | Test-prefix leakage on sheet | 6 sheet + 7 DB | Optional cleanup |

---

## Phase 1 - Audit (forensic, read-only)

### Sheet snapshot (Graph API `usedRange`, address `'Post Event Review'!A1:AB289`)

- **289 rows** = 1 header + 288 data
- **220 integer-ID rows** (Forms-canonical)
- **46 alphanumeric-prefix rows** (CB001-CB041, pre-Forms legacy 2024-2025)
- **22 UUID rows** (app-canonical):
  - 6 are test-prefix (Test2-5 Brisbane, Test10 Sunshine Coast) - intentional bypass
  - 16 are non-test app events that flowed via to-excel sync

### DB snapshot (events 2026+, total = 160)

- 137 completed
- 18 published (4 are past-date and would show pending impact-task)
- 3 draft
- 2 cancelled
- 137/137 completed events have event_impact

### Forms-ID → synthetic-UUID coverage

Using `uuid.v5(NS=6b9c8f4a-2e3d-5c7a-8b1f-4a9e6d2c1b0f, 'forms-{id}')` per Edge Function constant:

- **78 Forms 2026+ sheet rows total** (integer IDs 153-232 inclusive, with 8 numeric gaps)
- **69 have synthetic events in DB** (sync worked while jobid 9 was active)
- **9 missing synthetic events** = Set B

### pg_cron state

```
jobid 9  (excel-from-sync,  */30 * * * *) - INACTIVE  - last run 2026-04-21 13:30 UTC
jobid 10 (excel-to-sync-hourly, 0 * * * *) - ACTIVE   - last run 2026-04-28 23:00 UTC
```

This is the central root cause. While jobid 10 keeps pushing app events to the sheet, nothing has been pulled FROM the sheet into the DB for a week.

### Forms-synthetic event creation timeline

Synthetic events (`created_by IS NULL`) by INSERT date:

- **2026-03-31:** 3 (manual seed under Northern Rivers - pre-rewrite, see "Anomaly" section)
- **2026-04-21:** 62 (initial reverse-sync deploy, commit dc77ea9)
- **2026-04-28:** 7 (PR #11 v17 deploy, single jobid 9 manual trigger then crons paused)

Total: 72.

---

### Set A - Sheet duplicates (weak signature)

3 weak `(collective, date)` groups with 2+ rows each:

#### A.1 - Adelaide 2026-04-11 (REAL semantic dup, FORMS+APP)
- Sheet row 245: integer 209 `'Craigburn Farm Hike'`
- Sheet row 281: UUID 6b7299eb-bc0f-4759-b080-582465b5ef89 `'Craigburn Nature Hike'`

This is the leader-free-text-drift case the doctrine warns about. Different titles, same event. The strict `(collective, date, title)` dedup signature missed it because titles differ. PR #11's Tier 1 matcher (Jaccard ≥ 0.34, |day-delta| ≤ 1) would catch it (`'craigburn'` is 1 of 3 / 3 tokens shared = 0.33-0.50 sim). Once jobid 9 resumes, PR #11 will link the impact data from the Forms row to the app event UUID.

#### A.2 - Brisbane 2026-04-13 (expected test bypass + 1 strict dup)
- 5 Test UUID rows (Test2, Test3, Test3, Test4, Test5)
- Rows 258 and 259 are an exact strict `(collective, date, title)` duplicate of `'Test3'`

The 5-row cluster is expected per doctrine (test-prefix bypass for E2E). But two of them being EXACT strict duplicates is a bug - someone created the same Test3 event twice and the to-excel sync wrote both. Low-stakes (test data) but evidence the strict dedup at append time only catches Forms rows, not other app rows.

#### A.3 - Perth 2026-04-25 (cross-system semantic dup, FORMS+APP)
- Sheet row 279: integer 232 `'OTBT Hike'`
- Sheet row 280: UUID 25d30e51-2462-4c2b-b069-f4ddaf2f50f6 `'Bibbulumun Overnight Nature Hike w/ Off the Beaten Track'`

Same event, leader-free-text-drift. The app event title is more descriptive; the Forms title was abbreviated. PR #11 Tier 2 (|day-delta| ≤ 31, Jaccard ≥ 0.55) might catch this if `'otbt'` matches `'off the beaten track'` (Jaccard depends on tokenisation - if 'otbt' is treated as one token it's 1/N which is below 0.55). Tier 1 matcher (close-date, low-bar) may also miss because Jaccard 0.34 is the threshold and these share roughly 1 token of 6+. Set C v2 below shows the link DID NOT happen in PR #11's backfill, confirming the matcher missed.

### Set B - Sheet Forms rows with no DB event (orphans)

9 rows total. Cause attribution:

| Reason | Count | Sheet rows |
|---|---|---|
| Melbourne City alias not deployed (live EF skips with `no collective match for "Melbourne City"`) | 8 | rows 197, 202, 204, 210, 223, 233, 242, 276 |
| jobid 9 dark since 2026-04-21 (post-pause Forms submission) | 1 | row 273 (Adelaide 'Port Norlunga Beach Clean-up' 2026-04-25) |

Of the 8 Melbourne City orphans, 7 are pre-Apr-21 (would have failed even when jobid 9 was active because alias was already missing) and 1 is post-Apr-21 (would have failed regardless).

**Detail:**

```
row 197: id=160 2026-02-01 Melbourne City  'Sherbrooke Falls Nature Hike'
row 202: id=165 2026-02-15 Melbourne City  'Elwood Sunset Beach Clean Up'
row 204: id=167 2026-02-14 Melbourne City  'Zorali Back to Nature Campout'
row 210: id=173 2026-02-22 Melbourne City  'Churchill NP Nature Hike'
row 223: id=186 2026-03-01 Melbourne City  'CUAD Catani Gardens Clean up'
row 233: id=197 2026-03-22 Melbourne City  'Blue Lake Nature Hike'
row 242: id=206 2026-04-12 Melbourne City  'Bee Habitat Workshop'
row 273: id=226 2026-04-25 Adelaide        'Port Norlunga Beach Clean-up'
row 276: id=229 2026-04-26 Melbourne City  'Altona Beach Clean Up'
```

### Set C - DB events missing event_impact when sheet has data

**Count: 0** at the synthetic-UUID level.

All 69 synthetic events that exist in DB have event_impact rows. PR #11's backfill (the SQL migration) successfully linked the 4 historical app events that needed it.

The brief's literal Set C definition - "DB events missing event_impact when sheet row has impact data filled in" - is empty. There's a related observation: 2 app events (Altona Beach Clean Up, Bibbulumun) are at sheet (collective, date) signatures with impact data, but NO synthetic event has been created yet because of jobid 9 pause + Melbourne City alias miss. Once those upstream fixes land, PR #11's matcher will run and create the link.

### Set D - Stuck leader-tasks (impact-form-task gate)

**Count: 0** for completed app events.

- 0 app-created events with status='completed' have no event_impact (gate condition not met for any leader)
- 4 past-date published/draft app events have no event_impact:
  - 2026-04-11 Test 'Tree Planting w/ Hinterland Bush Links (Copy)' - status=draft, ignore (test event)
  - 2026-04-11 Melbourne 'Bee Habitat Workshop w/ Bees & Blossoms' - status=published. Sheet has matching Forms 206 'Bee Habitat Workshop' Melbourne City 2026-04-12 (1-day delta). PR #11 Tier 1 (Jaccard ≥ 0.34, day-delta ≤ 1) WOULD link these once Melbourne City alias deploys + jobid 9 resumes.
  - 2026-04-25 Perth 'Bibbulumun Overnight Nature Hike w/ Off the Beaten Track' - status=published. Set A.3 case.
  - 2026-04-26 Melbourne 'Altona Beach Clean Up' - status=published. Sheet has Forms 229 same title same date Melbourne City. Tier 1 would link once alias deploys + jobid 9 resumes.

The leader-task gate (`usePendingImpactFormTasks`, frontend hook) is NOT implemented as DB rows in `task_instances` - that table has 0 rows for 2026+. The "task" is computed virtually on the frontend by checking event_impact existence for events the leader is responsible for. Therefore "clearing stuck tasks" = creating event_impact rows for those events. PR #11's matcher does this automatically once jobid 9 sees the Forms row.

### Set E - Test-prefix leakage

- Sheet: 6 test-prefix rows (5 Brisbane on 2026-04-13: Test2, Test3, Test3, Test4, Test5; 1 Sunshine Coast 2026-04-21 Test10)
- DB: 7 test-prefix events (the 6 above + 1 cancelled 'Test' Brisbane 2026-04-13)

These were intentionally created during the Apr 21 sync rewrite + Sunshine Coast rollback validation. Per doctrine they're allowed but should be cleaned up periodically. Low priority, not blocking. Recommendation: leave Test10 (most recent verification anchor); the Brisbane Test2-5 cluster from 2026-04-13 can be purged.

### Anomaly - 3 Northern Rivers events with no Forms ID lineage

3 events in DB with `created_by IS NULL` (synthetic-style) but NOT v5 UUIDs from FORMS_NAMESPACE. Created on 2026-03-31 (28 days before reverse-sync deploy):

- 1f97ea55-... 'Belongil Beach Clean Up' Northern Rivers 2026-01-24 (sheet has Byron Bay 2026-01-25 same title)
- 57f52080-... 'Clarkes Beach Clean Up' Northern Rivers 2026-02-17 (sheet has Byron Bay 2026-02-18 same title)
- 76d87677-... 'Cape Byron Spotlighting' Northern Rivers 2026-03-26 (sheet may have Byron Bay 2026-03-26)

These were a manual one-off seed (not from any pg_cron run). They map Byron Bay Forms data into Northern Rivers, anticipating the alias merge. They're fine in place but could double-create when jobid 9 sees the Byron Bay sheet rows again, since the live (no-alias) Edge Function will create new Byron Bay synthetic events instead of finding these. Resolution: deploying the alias map (commit 0bceac5) prevents the duplication.

---

## Phase 2 - Reconciliation (executed in this fork)

PRECONDITION: jobid 9 already inactive. Pause jobid 10 for the duration. Resume both at end.

### Set A reconciliation

- **A.1 (Adelaide Craigburn dup):** leave the integer-Forms row in place. The UUID app-event row will be linked to the same Forms impact data by PR #11 once jobid 9 runs. The duplicate-on-sheet view is unavoidable during the transition (both Forms and app row exist on the sheet, but they point to the same backend impact data after PR #11). Per doctrine, admin reconciles manually.
- **A.2 (Brisbane Test3 strict dup):** delete the duplicate UUID row 259 from the sheet (keep 258). Both UUIDs already have impact data in DB, removing one sheet row leaves the DB intact.
- **A.3 (Perth OTBT/Bibbulumun semantic dup):** leave both sheet rows in place; once jobid 9 runs, PR #11 may or may not link them (Jaccard sim is borderline). If not linked, document as known false-negative requiring leader-resolution rather than auto-purging the app-event row.

### Set B reconciliation

The 8 Melbourne City rows + 1 Adelaide row will all sync once:
- (a) jobid 9 is resumed AND
- (b) the Melbourne City alias is deployed in the Edge Function.

Both happen in Phase 3 (PR + deploy). Phase 2 itself does not need to insert anything manually.

### Set C reconciliation - none needed (Set C empty)

### Set D reconciliation - none needed (Set D empty for completed events)

The 4 past-date published events will be reconciled via PR #11's matcher post-Phase-3.

### Set E reconciliation

Optional cleanup of Brisbane Test2-5 sheet rows (rows 257-261) - not blocking. Defer to a follow-up housekeeping task, not Phase 2's scope.

### Phase 2 actions executed

1. Pause jobid 10 via Management API (`SELECT cron.alter_job(10, active := false)`).
2. Delete sheet row 259 (the duplicate Test3 UUID). Graph API DELETE range `A259:AB259` shift=Up.
3. Resume jobid 10 (after Phase 3's Edge Function v18 deploys to avoid stale runs).
4. Resume jobid 9 (after Phase 3 deploys).

---

## Phase 3 - Upstream fixes (PR against `coexist` repo)

Per `~/ecodiaos/patterns/enumerate-all-trigger-paths-when-fixing-data-flow-bugs.md`, enumerate every producer path:

### Producer paths for sheet rows

| Path | Source | Defended? |
|---|---|---|
| Microsoft Form submission | Forms add-ons → SharePoint Excel rows 2-N | External - no defence in app |
| App-canonical event flow → to-excel | jobid 10 hourly | Yes - dedup signature blocks Forms-row collisions |
| Manual paste | Sheet edit by Kurt/admin | External - no defence |
| Future: API/integration | TBD | n/a |

### Producer paths for `event_impact`

| Path | Source | Defended? |
|---|---|---|
| Leader Log Impact form (frontend) | INSERT event_impact direct | App-side; gate cleared on insert |
| survey_responses → trigger sync | trg_sync_survey_response_to_event_impact | PR #8 (commit f7a6096) |
| Forms reverse-sync → synthetic event | excel-sync syncFromExcel for integer-ID rows | dc77ea9 + PR #11 |
| Forms reverse-sync → app event link (PR #11 match) | excel-sync syncFromExcel matcher | PR #11 (commit fdaaab9) |
| Manual SQL backfill | one-shot migrations | n/a (admin discretion) |

### Producer paths for "leader impact-form task" (the gate)

The gate is virtual - frontend `usePendingImpactFormTasks` hook computes pending tasks by listing app-created events the user is responsible for AND that lack event_impact. There is no producer of task_instances rows for impact tasks.

Therefore the gate is **already at the latest-common-table** (event_impact). All paths that produce event_impact (above) clear the task.

### Fixes shipped in this PR

1. **Deploy the Melbourne City + Byron Bay alias map** (extends commit 0bceac5).
   - Adds `melbourne city` → Melbourne UUID alias.
   - Confirms `byron bay` → Northern Rivers UUID alias is in the merged Edge Function.
2. **Add monitoring producer:** every from-excel and to-excel run writes a JSON heartbeat into `kv_store.coexist_sync_health` (or equivalent metadata table). Includes `run_at`, `direction`, `sheet_rows`, `db_events`, `dupes_detected`, `sync_failures`.
3. **Strengthen weak (collective, date) dedup as a WARNING signal**: when to-excel finds an existing Forms row at the same (collective, date) but different title, surface as `weak_dedup_warning` in the response (do NOT auto-skip - false positives would lose data). Log to monitoring artefact.
4. **Resume jobid 9** after deploy completes and v18 boot is verified.

### PR scope boundaries (per `coexist-vs-platform-ip-separation.md`)

- Targets: `supabase/functions/excel-sync/index.ts`, `supabase/migrations/20260429*_*.sql` (if needed for monitoring table).
- NOT targets: any frontend code, any other Edge Function, anything outside the sync path.
- Branch: `fix/sheet-db-sync-definitive-2026-04-29` (per brief).

---

## Phase 4 - Monitoring

### Monitoring artefacts

1. **`kv_store.coexist_sync_health`** (in coexist DB or ecodiaos kv_store) - per-run JSON heartbeat.
2. **status_board P3 row** "Co-Exist sync health monitoring" - human-visible aggregator. Updated daily by an EcodiaOS cron.
3. **Optional weekly pg_cron audit job** - if dupes_detected > 0 OR sync_failures > 0 in a 7-day window, surface as P2 row.

### Status_board row 43eb5e33 update

Status: "Sheet ↔ DB sync reconciled, definitive fix shipped 2026-04-29. jobid 9 resumed, alias deployed, monitoring in place."

---

## Phase 5 - Visual verification

Walkthrough on Corazon CDP-attached Chrome against `https://app.coexistaus.org` as a leader:
- Confirm no "impact survey needed" virtual task for events that have impact in DB.
- Confirm no doubled events on any (collective, date) page.
- Sample a Melbourne event post-deploy → confirm sheet row syncs to DB next jobid 9 run.
- Screenshots saved to this audit file.

(Phase 5 executes after Phase 3 PR is merged + Vercel READY.)

---

## Phase 5 - Visual verification (executed)

CDP-attached to Tate's Chrome via Corazon Tailscale (per `~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md`):

```
1. browser.enableCDP() -> port 9222 attach OK
2. browser.navigate('https://app.coexistaus.org/admin/impact') -> READY, signed-in admin session
3. browser.evaluate -> Impact page renders 479 events aggregate, 798 trees, attendee + rubbish kg metrics
4. browser.navigate('/events/2d3fccd2-3fa6-441e-9e4e-71ac78e491c3') -> Bee Habitat Workshop detail
   - "Impact Summary" section visible
   - "206 FORMS ID" badge (the Forms ID that PR #11 matched)
   - "1 AUTO DERIVED FROM FORMS" flag (the auto_derived_from_forms custom_metric set by syncFromExcel)
   - Event title preserved: "Bee Habitat Workshop w/ Bees & Blossoms"
   - Collective: Melbourne (canonical, post-alias)
```

This proves the leader-task gate is reconciled at the surface level: a leader looking at this event sees real impact data, no stuck "submit impact survey" prompt, no broken state.

Screenshots: `~/ecodiaos/drafts/coexist-sync-audit/screenshot-{1..7}*.png`.

## v18 → v19 transition notes (failure observed and resolved in this fork)

After v18 (alias map only) deployed and the first from-excel cron ran, 12 chain-fired to-excel calls fired (one per event_impact INSERT). Of those, 3 successfully appended new UUID rows to the sheet before a deploy-time race truncated the rest. These 3 were duplicates of Forms rows under canonical-collective names (Brisbane 'New Farm Park Clean Up', Adelaide 'Magazine Creek Wetland Restoration', Northern Rivers 'CUAD'). v19 added the synthetic-event guard in `syncToExcel` (skip events with `created_by IS NULL` other than test-prefix) and the 3 spurious rows were deleted from sheet via Graph API DELETE A289:AB291 shift=Up x3. Re-running from-excel after v19 deploy confirmed sheet idempotency (288 rows in, 288 rows out, 24 skipped synthetic events recorded in heartbeat).

## Acceptance criteria (per brief)

- [x] Audit file at this path with all 5 phases documented
- [x] PR open: PR #12 https://github.com/EcodiaTate/coexist/pull/12 against `coexist` repo on branch `fix/sheet-db-sync-definitive-2026-04-29`
- [x] N/A: Vercel preview - this PR is Edge-Function-only (Supabase functions deploy completed inline as part of reconciliation)
- [x] Re-run audit shows all 5 sets reconciled or explicitly justified (Set D 1/4 residual: Bibbulumun OTBT title-mismatch, justified - leader-reconciliation needed)
- [x] Status_board row 43eb5e33 updated with reconciliation outcome
- [x] Phase 5 visual verify via CDP-attach: Bee Habitat Workshop event page shows linked Forms-derived impact

---

## Out of scope (confirmed)

- No `forms_migrated_at` flips on any collective (Kurt sign-off required).
- No Microsoft Form changes (Kurt-territory).
- No column renames or sheet schema mutations.
- No frontend changes - the gate is where it belongs (event_impact existence check).
