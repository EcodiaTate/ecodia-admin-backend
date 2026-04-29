# Status board drift audit - 2026-04-29 21:45 AEST

Fork: fork_mojzp38a_cbb1b5
Trigger: meta-loop cron Phase 2 (canonical drift audit per `~/ecodiaos/patterns/status-board-drift-prevention.md`)

Pre-flight applied:
- Read pattern file `status-board-drift-prevention.md` in full.
- Grepped `~/ecodiaos/patterns/` for triggers status-board / drift / audit / reconciliation / completion-row / monitor / archive (22 matches).
- Tagged surfaced patterns:
  - `[APPLIED] ~/ecodiaos/patterns/status-board-drift-prevention.md` because canonical Phase 2 audit doctrine.
  - `[NOT-APPLIED] ~/ecodiaos/docs/secrets/bitbucket.md` because audit operates on local Supabase status_board only.
  - `[NOT-APPLIED] ~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` because the deliverable is artefact, not log; writes were applied first, file second.
- 5-fork-context: I am a single audit fork; no parallel writes against the same rows.

---

## Section 1 - Total row count and breakdown

Pre-audit baseline (~21:42 AEST):
- Total active rows: **123**
- Priority distribution: P1=9, P2=39, P3=53, P4=15, P5=7
- Owner distribution: ecodiaos=48, tate=66, client=1, external=8 (computed from breakdown)
- Stale > 7 days: 0 (the 12h reconciliation cron + listener writes have been bumping `last_touched` even when the underlying state did not change - so relative-time staleness is not a useful signal here. Substantive drift dominates.)

Post-audit: **119 active rows** (4 archived this run, 12 status-changed this run).

---

## Section 2 - Drift findings (per row)

### ARCHIVES (4)

#### 1. `0164fa7f-deac-4bbf-a976-94cac844c5db` - Cowork-conductor deep connection
- Mode 2: completed-not-archived.
- Status was `shipped_v1`; pattern file authored, primitive verified, dispatch protocol live.
- Optional follow-up cron probe + auto-switch-back macro is a separate scoping question and does not need a P2 row.
- Applied: `UPDATE ... SET archived_at = NOW(), last_touched = NOW()`.

#### 2. `85c4521a-979e-48c6-9745-a85b2f158c0b` - Secrets registry shipped per pattern-file convention
- Mode 2 + Mode 3: completed work + pure-awareness next_action ("Use it: before any cred-needing action, grep ~/ecodiaos/docs/secrets/").
- Status `Live`. cred-mention-surface.sh is registered and active per CLAUDE.md "Mechanical surfacing hooks (active 29 Apr 2026)".
- Doctrine, not actionable. Belongs in CLAUDE.md (already there).
- Applied: `UPDATE ... SET archived_at = NOW(), last_touched = NOW()`.

#### 3. `46f6e659-08f5-4bf4-9877-0dbfaac0d304` - SCYCC Chambers operating licence v1 (held draft)
- Mode 1: duplicate.
- Same Chambers/SCYCC/Matt thread is covered by `a2c83a3a` (Matt Barmentloo / SCYCC Chambers - app delivery) and `21f59cf6` (Chambers federation play - tenant 2+).
- Next_action ("Tate review prod URL, approve email send to Matt + provide DNS for chambers.ecodia.au") is identical to a2c83a3a.
- The 3-rows-on-1-thread pattern is exactly the example called out in `status-board-drift-prevention.md` Mode 1 ("CETIN + CETIN MVP + Resonaverde").
- Applied: archive 46f6e659; keep a2c83a3a (delivery row) + 21f59cf6 (broader federation play - distinct scope).

#### 4. `ee6895af-2f2d-4c1c-8255-b3b9268072dc` - Supabase RLS-disabled across multiple projects
- Mode 1 + Mode 2: umbrella row that has served its triage purpose ("4 of 8 fixed, 4 surfaced for Tate review").
- The 4 remaining items are tracked individually as `1dc7cd20`, `dd603107`, `452b2122`, `53b76a0a` - the umbrella is redundant.
- Applied: archive umbrella; keep 4 individual P3 rows.

### STATUS CHANGED (12)

#### 5. `2a224645-43a0-445d-9640-fb9a78824dfc` - 8-layer Decision Quality Self-Optimization Architecture
- Internal inconsistency: row name said "B+C+D+E+G SHIPPED, A/F pending" but status text said "Phase B shipped. Next: Phase C". Per CLAUDE.md "Phase C (Layer 3) - applied-pattern-tag forcing function (active 29 Apr 2026)" - Phase C IS shipped.
- Updated status to "Phase A + B + C all SHIPPED 29 Apr 2026". Refreshed next_action to clarify remaining is D + F.

#### 6. `4b4959ac-89cc-447c-8e64-32bf3690cb18` - CETIN MVP (Angelica)
- Mode 4: stale-relative-day-language. Old text contained "target Apr 11, 2026 wait, that is past — recheck May 11".
- Refreshed to clean phrasing: "Cold since 21d earlier; recheck May 11 2026 if no signal by then."

#### 7. `6fcf6af6-90ba-4faa-a697-45379455c751` - Woodfordia / Conservatree digital layer pitch
- Mode 4: stale-relative-day-language ("end of April now").
- Refreshed; added concrete `next_action_due = 2026-05-06` so the row auto-surfaces if not picked.

#### 8. `9a3b4c6e-a3b4-4bfc-be1b-6ba1cc3a99e1` - eos-laptop-agent vision.locate primitive broken (OAuth 401)
- Obsolete-by-pivot. Per CLAUDE.md (29 Apr 2026 doctrine), vision.locate is part of the bespoke macro runtime being replaced by Anthropic computer-use API + Cowork.
- Updated status to OBSOLETE. next_action: do NOT fix the OAuth 401; re-author affected use cases via Cowork or cu.* path. Archive after pivot fully lands.

#### 9. `ff6fcf6e-c0ae-4fc3-bdc8-16baac6b279b` - First autonomous-learning macro: resend-rotate-api-key
- Obsolete-by-pivot. Resend dashboard is exactly the Cowork-1stop-shop substrate per `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md`.
- Updated status: OBSOLETE. next_action: re-author as Cowork dispatch on next real Resend rotation need; do NOT replay-validate the bespoke runbook.

#### 10. `b97f443d-3bd7-42b5-b159-bbcf4d7f330a` - Corazon-as-peer build-out
- Status referenced doctrine shift to "autonomous vision + question-surface" (now superseded by 29 Apr 2026 Cowork-first / cu.* fallback pivot).
- Refreshed to current substrate stack: input.* + screenshot.* primary, Cowork for web SaaS, cu.* for OS-level fallback. Decommission vision.locate / question.surface / runbook.* primitives in cleanup fork.

#### 11. `e17b6613-3885-45e2-a46c-74868e1a81df` - Macros Phase 1 brief expansion (6 hallucinated handlers)
- Same pivot impact. The 5 retracted web-target macros (github-login, stripe-dashboard, gmail-send, supabase-dashboard, vercel-redeploy) are the canonical Cowork workflows.
- Refreshed: github-login + stripe-dashboard + supabase-dashboard + vercel-redeploy via Cowork; gmail-send via direct gmail_send MCP tool (no GUI); macincloud-login stays stub or input.* on SY094.

#### 12. `68d2a471-96dc-4526-8157-7e1c337f7b33` - Macro pivot to computer-use - schema migration phase 1
- Set explicit `next_action_due = 2026-05-06` (column drop scheduled +7 days from 29 Apr ship).
- Clarified cu.* role as fallback (OS-level / desktop-app), not full macro-fleet primary, post-pivot-clarification.

#### 13. `a04bdabf-4f3d-4662-b5c2-6abd88a2a455` - runbook.load and runbook.list 500 with PG error
- Obsolete-by-pivot. The endpoints back the bespoke macro runtime being decommissioned.
- Updated status: OBSOLETE. next_action: do NOT fix the array_length error; archive in cleanup fork after schema phase-2 column drop on 2026-05-06.

#### 14. `424db333-8447-4907-bc26-beebae257a9c` - Google Play Developer service account not wired
- Demoted-by-doctrine. `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` says GUI-macro path supersedes API-key generation when both work.
- Refreshed: AAB upload via Cowork dispatch against Tate Chrome at play.google.com/console; only generate SA JSON for fundamentally headless cron need. Owner moved from `tate` to `ecodiaos` (no human action needed - Cowork path is autonomous).

#### 15. `e3b24dfd-cd11-45ce-92e0-1a3a20af423e` - Mobile sign-in GUI verification consolidated checklist
- Outdated tool reference. Old next_action said "via eos-laptop-agent enableCDP" but enableCDP is now reserved for CDP-specific need per CLAUDE.md.
- Refreshed: drive via input.click + screenshot.screenshot per Chrome-driving doctrine, or Cowork for the dashboards it covers.

#### 16. `d3e39d28-1f0d-478a-9146-a2213b2a41c4` - eos-laptop-agent enableCDP returns false success
- Internal inconsistency: status said "patched + verified across all 6 tools/*.js files" but next_action said "Patch process+filesystem.js for full coverage (now done) + commit backups". The "(now done)" parenthetical contradicted the action item.
- Refreshed: reduce next_action to just the residual git-commit-backups decision.

### STILL ACCURATE (no-op count)

P1: 8 of 9 still accurate (only `2a224645` needed update). All others verified against ground truth (CLAUDE.md, Neo4j, fork status, file existence).

P2: 25 of 39 still accurate. Notable verified-fresh rows:
- `8a6e0571` (Factory phantom-failing) - just re-verified 21:43 AEST.
- `48ca3ca4` (PR #16 merged, deploy deferred to nightly) - DO NOT TOUCH per brief.
- `4d860500` (post-action-applied-tag-check.sh detection) - DO NOT TOUCH per brief, active investigation.
- `c7eea2bd`, `62f8c918`, all outreach drafts (Crystal Waters, NSW LLS, HLW, NRM Regions), all conservation deck rows, all DAO rows.

P3: 51 of 53 still accurate. 2 updated (9a3b4c6e + a04bdabf above).

P4: 15 of 15 still accurate.

P5: 7 of 7 still accurate.

### DUPLICATE (1 archived as part of dedup)

`46f6e659` archived; `a2c83a3a` + `21f59cf6` retained as canonical Chambers/SCYCC rows.

### Borderline (NOT acted on - documented for next sweep)

- `4b4959ac` (CETIN MVP) and `1fb327ea` (Angelica/CETN Resonaverde referral) - distinct workstreams under the same client (build vs referral) but cited in pattern doctrine as a recurring duplicate-shape. Kept distinct because the next_actions are genuinely different (referral inbound + draft v0.3 vs build agreement awaiting referral signature). Reassess if both go cold simultaneously.
- `42f60afc` (Macro pivot Corazon cu.* executor) - "Wait for ecodiaos-backend run-via-computer-use route to dispatch first real run" is monitor-without-trigger but the row is < 24h old. Reassess in next sweep.
- `43eb5e33` (Co-Exist) - "Steady state. Watch for Brendan/Samsung leader feedback" is monitor-without-trigger but Co-Exist is a live client and the row anchors awareness. Keep.
- `8b12cfd9` (Email-triage cron decommission watch) - has explicit conditional ("If N>0 events fired with zero misses") but no concrete date. Keep; revisit if Wave B 24h elapsed without action.

---

## Section 3 - Cap status

Cap: 25 drift writes per run.
Applied this run: **16 writes** (4 archives + 12 status-change UPDATEs).
Cap headroom remaining: 9.

No tail queued for follow-up audit. The substantive drift surface this run was dominated by:
1. The 29 Apr 2026 macro-runtime pivot (5 rows: 9a3b4c6e, ff6fcf6e, b97f443d, e17b6613, a04bdabf - all flag-as-obsolete or refresh-substrate).
2. Completed-shipped-but-not-archived (3 rows: 0164fa7f Cowork-conductor, 85c4521a secrets registry, 46f6e659 SCYCC duplicate).
3. Doctrine-supersession (3 rows: 424db333 Play SA, e3b24dfd CDP, 68d2a471 cu.* role).
4. Stale-relative-day-language (2 rows: 4b4959ac, 6fcf6af6).
5. Internal-inconsistency / contradiction (2 rows: 2a224645 Phase C status, d3e39d28 "(now done)" parenthetical).
6. Umbrella-row-redundancy (1 row: ee6895af RLS).

---

## Section 4 - Pattern observations (drift modes)

### Recurring drift mode A: doctrine pivot ahead of status_board catch-up
The 29 Apr 2026 pivot to Anthropic computer-use + Cowork (replacing the bespoke vision.locate / runbook.* runtime) shipped to CLAUDE.md and pattern files but the status_board rows that pre-dated the pivot still framed work in pre-pivot terms. 5 rows above (9a3b4c6e, ff6fcf6e, b97f443d, e17b6613, a04bdabf) all needed status text refreshed to acknowledge the pivot.

**Suggestion:** when a major doctrine pivot lands, the same fork that authors the pattern file should run a `SELECT id, name FROM status_board WHERE archived_at IS NULL AND (status ILIKE '%<old-tool>%' OR next_action ILIKE '%<old-tool>%')` and refresh affected rows in the same turn. The current 12h reconciliation cron probes ground truth via vercel/gmail/git/cc_sessions but does NOT probe ground truth against doctrine. Consider extending it.

### Recurring drift mode B: completed-shipped but not archived
3 rows (0164fa7f, 85c4521a, 46f6e659) had `status` containing "shipped" or "Live" but stayed active because the next_action was a doctrine-reminder ("use it") rather than a concrete to-do. Mirrors Mode 2 + Mode 3 in the canonical pattern file.

**Suggestion:** when authoring next_action on a completed-shipped row, the prompt should be "is this a TASK or a DOCTRINE?" If doctrine, archive the row and add the doctrine to CLAUDE.md / pattern file instead.

### Recurring drift mode C: umbrella row outliving its triage purpose
1 row (ee6895af) was an umbrella covering 8 RLS-disabled tables. After 4 were fixed and 4 surfaced as individual rows, the umbrella row became redundant. Same pattern shape as the canonical pattern file's Mode 2 ("monitor with no trigger condition").

**Suggestion:** umbrella rows should be archived the moment all sub-items are individually tracked. The umbrella's purpose is triage handoff, not durable awareness.

### New drift mode noted (not yet in pattern file): internal-inconsistency
2 rows (2a224645, d3e39d28) had self-contradicting text where the status field and the next_action field disagreed (e.g. "Phase B shipped. Next: Phase C" while the row name said "B+C+D+E+G SHIPPED"; status saying "patched across all 6 files" while next_action said "Patch process+filesystem.js for full coverage (now done)"). The "(now done)" form is particularly insidious because it reads as a current statement but is actually historical.

**Suggestion:** add to `status-board-drift-prevention.md` as a named drift mode: "Mode 5: status-action-contradiction. The status field and next_action field tell different stories; one was updated and the other was not." Detection protocol: on every UPDATE that changes `status`, the conductor must explicitly re-read `next_action` and reconcile or rewrite. Will codify in a follow-up doctrine fork if observed again.

---

## Final summary

| Metric | Count |
|---|---|
| Rows audited (full active set) | 123 |
| Archived this run | 4 |
| Updated this run | 12 |
| Deduped this run | 1 (46f6e659) |
| Still-accurate no-op | 106 (123 - 16 written - 1 dedup-archived counted in archives = 106) |
| Active rows post-audit | 119 |
| Cap headroom remaining | 9 of 25 |

All writes applied as single-row UPDATEs per `status-board-drift-prevention.md` enforcement. No CASE-WHEN, no DELETE, no batch.

End of audit.
