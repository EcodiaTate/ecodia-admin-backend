# Conductor queue, 29 Apr 2026 21:53 AEST

Fork id: fork_mojzybbn_b16955. Audit-only. Brief explicitly forbids dispatching any of these forks - the conductor reviews + dispatches.

Source materials surveyed:
- 5 most recent fork deliverables in `~/ecodiaos/drafts/` from the last ~6 hours: post-action-applied-tag-check defect investigation (11:44 UTC), claude-md-gaps-audit-evening (11:35 UTC), ecodiaos-backend-self-evolution-audit (11:32 UTC), conservation-platform-rebrand/network-adjacency-audit (11:45 UTC), conservation-platform-rebrand/nrm-regions-marnie-lassen-dossier (11:34 UTC).
- `kv_store.ceo.day_plan_2026-04-30` (canonical schema, authored 11:15 UTC by fork_mojyf0vm_e59740).
- `status_board` rows where `next_action_by='ecodiaos' AND priority IN (1,2,3) AND last_touched > NOW() - 24h AND archived_at IS NULL` (28 rows surveyed).
- `os_scheduled_tasks` for duplicate-cron drift signal: confirmed `phase-G-adversarial-audit` exists with two rows at `daily 03:00` and `daily 22:00` (decision-needed surface).
- Live verification probes: `~/ecodiaos/scripts/hooks/cowork-first-check.sh` exists at 6680 bytes (shipped 11:43 UTC, post-dates the 21:30 AEST gap audit), Quorum 003 + 004 + 005 HTML drafts all present in `~/ecodiaos/public/docs/`.

Priority ordering used (per brief):
- P1: blocks active client work or revenue.
- P2: fixes a recently-surfaced defect (any in-flight bug or doctrine drift).
- P3: doctrine / pattern authoring.
- P4: dossier / research deepening.
- P5: speculative or exploratory.

The 5 briefs below are listed P2, P2, P2, P3, P4. There are no P1 candidates that are simultaneously (a) revenue-blocking and (b) shaped as a single-fork bounded deliverable - the existing P1 status_board rows are either already in-flight (Phase B+C decision-quality continuation, context-surfacing audit re-dispatch) or sit in a different primitive class (Tate-blocked items per the 5-point check). The two flagged P1 status_board rows (8-layer Decision Quality remaining Phases D+F, context-surfacing end-to-end audit re-dispatch) are already addressed in the day_plan 12h horizon and have specific phase briefs at `~/ecodiaos/drafts/phase-{D,F}-*.md` ready to consume - they are not net-new candidates this audit needs to surface.

---

## Brief 1 - Fix post-action-applied-tag-check.sh canonical-path-form detection (P2)

**Goal.** Patch `~/ecodiaos/scripts/hooks/post-action-applied-tag-check.sh` so it recognises the canonical absolute-path tag form (`[APPLIED] /home/tate/ecodiaos/docs/secrets/bitbucket.md because ...`) AND the keyname form (`[APPLIED] secrets:bitbucket because ...`) emitted by `cred-mention-surface.sh`, eliminating the [FORCING WARN] false positives currently polluting the `application_event` `tag_distribution` telemetry panel.

[APPLIED] /home/tate/ecodiaos/patterns/decision-quality-self-optimization-architecture.md because the hook is the Layer 3 forcing function shipped 29 Apr 2026 and the fix sits inside that architecture.
[APPLIED] /home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because the bug renders [APPLIED]/[NOT-APPLIED] tags symbolic when they should be load-bearing.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/bitbucket.md because no Bitbucket / Atlassian operation; this is a hook-script edit on the VPS only.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-passkey.md because no Windows GUI operation.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because no UI / webapp / Chrome operation.

**Pre-flight.**
1. Read `~/ecodiaos/drafts/post-action-applied-tag-check-defect-investigation-2026-04-29.md` end-to-end - it is the canonical investigation artefact, includes test scaffolds at Section 6, and proposed-patch sketch.
2. Read `~/ecodiaos/scripts/hooks/post-action-applied-tag-check.sh` end-to-end.
3. Read `~/ecodiaos/scripts/hooks/cred-mention-surface.sh` for the keyname-form output shape.
4. Read `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` for the absolute-path form output shape.
5. Read `~/CLAUDE.md` "Applied-pattern tag protocol" worked example AND `~/ecodiaos/CLAUDE.md` "Worked example - cred-surface tag format" - these are the two doctrinal anchors that specify both forms must be accepted.
6. Grep `~/ecodiaos/patterns/` for triggers matching: `applied-pattern, tag-protocol, forcing-function, post-action, hook-detection, surface-event`.

**Methodology.**
1. From the investigation doc Section 5, extract the proposed patch shape (a multi-form tag-detection regex set OR an `alt`-substitution loop that expands a surface to its synonymous forms - secrets:bitbucket also matches `~/ecodiaos/docs/secrets/bitbucket.md` and the absolute path).
2. Implement the patch as a single bash function (add to the hook) that takes a surface keyname OR path and returns ALL synonymous forms.
3. Update the tag-presence check to accept ANY of the synonymous forms.
4. Run the three test scaffolds from Section 6 of the investigation doc: 6.1 (positive test, both tag forms), 6.2 (negative test, genuinely silent dispatch), 6.3 (end-to-end via real fork dispatch).
5. Verify with `db_query` against `application_event` that no new `tagged_silent=true` rows fire on briefs containing canonical path-form tags.
6. Author a Neo4j Decision node "post-action-applied-tag-check.sh canonical-path-form acceptance fix shipped 29 Apr 2026" linking to the investigation doc + the patched hook file.

**Constraints.**
- Do NOT modify the upstream surfacing hooks (`cred-mention-surface.sh`, `brief-consistency-check.sh`) - the bug is in the post-action detector, not the surfacers.
- Do NOT change the `application_event` table schema. The fix is in detection logic only.
- Do NOT introduce a flag or env var to gate the fix. Both forms are canonical per doctrine; the hook should accept both unconditionally.
- The hook is bash; bash is not Node-cached. No `pm2 restart` needed. Edit + save is the deploy.
- No em-dashes anywhere. Verify before commit.
- After patching, archive `status_board` rows `4d860500` (canonical-form bug) and the cred-mention-surface false-positive row by setting `archived_at = NOW()`.

**Done = ** patched hook file committed to `ecodiaos-backend` main, three test scaffolds pass (6.1 emits zero [FORCING WARN] for both tag forms, 6.2 emits both [FORCING WARN] for genuine silence, 6.3 produces clean `application_event` rows with `applied=false, tagged_silent=false, reason=<extracted>`), and a 30-minute post-deploy `tagged_silent=true` row count for `pattern_path LIKE 'secrets:%'` is at or near zero (allow up to 1 in case of a genuinely tag-less brief in flight).

---

## Brief 2 - Apply forkService.js _dbInsert await fix (1-line race fix) (P2)

**Goal.** Add `await` to the `_dbInsert(state)` call at `src/services/forkService.js:691` to close the INSERT-side of the same race that commit `e4bd2a7` fixed on the three `_dbUpdate` call sites (771, 865, 945). Eliminates the stuck-in-spawning ghost-fork bug that the os-forks-reaper cron will otherwise mis-classify.

[APPLIED] /home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because the audit fork named the fix as load-bearing and queueing it without dispatch is symbolic logging.
[APPLIED] /home/tate/ecodiaos/patterns/fork-by-default-stay-thin-on-main.md because forkService.js is THE fork-dispatch primitive; a latent race here breaks the conductor's primary tool.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/bitbucket.md because the change is on the EcodiaTate/ecodiaos-backend GitHub repo via PR + merge, not on a Bitbucket-hosted client repo.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because no UI / webapp / Chrome operation; this is a 1-line code edit + commit.

**Pre-flight.**
1. Read `~/ecodiaos/drafts/ecodiaos-backend-self-evolution-audit-2026-04-29.md` end-to-end - it is the canonical audit, includes the dispatch brief verbatim at the end of the document.
2. `git show e4bd2a7 -- src/services/forkService.js` - see the existing pattern that this fix mirrors.
3. Read `src/services/forkService.js` lines 670-790 to see the surrounding context (the IIFE at line 721 fires `_dbUpdate` before INSERT resolves).
4. Verify `spawnFork` is `async` (it is, per the audit) before adding `await`.

**Methodology.**
1. Open `src/services/forkService.js`. Change `_dbInsert(state)` at line 691 to `await _dbInsert(state)`.
2. Optionally add a one-line comment above: `// must await: ensures row exists before run-loop UPDATEs (sibling fix to e4bd2a7)`.
3. `git diff` to confirm 1-3 lines changed in one file.
4. `git checkout -b self-evo/forkservice-insert-await-fix-2026-04-29` (no embedded date suffix collision per parallel-forks-must-claim-numbered-resources doctrine; branch name uniqueness checked at create time).
5. `git commit` with message referencing commit `e4bd2a7` as the sibling-fix anchor.
6. `git push origin <branch>`.
7. `gh pr create` with title and description naming the audit doc as source.
8. Self-merge to main (single-line fix, audit-backed; no human-review gate needed for self-evolution scope).
9. Verify `os-forks-reaper` next run (within 30m) does NOT classify any newly-spawned fork as stuck.
10. Archive `status_board` row covering the audit recommendation by setting `archived_at = NOW()` after merge confirms.

**Constraints.**
- Do NOT add tests; the audit explicitly states no test changes are required and the synthetic race injection would be out of scope.
- Do NOT touch the three `_dbUpdate` call sites - they are already fixed in `e4bd2a7`.
- Do NOT chain the IIFE off the INSERT Promise (more invasive alternative explicitly rejected by the audit).
- Do NOT scope-creep into other findings flagged in the audit's "Out-of-scope items observed" section (duplicate cron names, computeNextRun null path, tate-blocked-nudge-weekly naming drift) - those are separate forks.
- Per ~/ecodiaos/CLAUDE.md self-evolution scope-discipline: target is `ecodiaos-backend` only, no client-codebase changes.
- No em-dashes.

**Done = ** PR opened with 1-3 line diff in `src/services/forkService.js` only, merged to main, commit SHA recorded in `os_scheduled_tasks` outcome notes if the next reaper-run completes cleanly. Status_board row archived. Neo4j Decision node "forkService.js _dbInsert await race fix shipped 29 Apr 2026" linked to the audit doc and the merge commit.

---

## Brief 3 - Phase G adversarial-audit duplicate-cron decision + os_scheduled_tasks unique-name guard recon (P2)

**Goal.** Decide which `phase-G-adversarial-audit` cron schedule keeps (currently both `daily 03:00` AND `daily 22:00` are active per `os_scheduled_tasks` query 21:53 AEST), cancel the duplicate, and produce a recon doc for adding a unique-name guard to `mcp-servers/scheduler/index.js:69-73` (the INSERT path that does NOT enforce uniqueness today).

[APPLIED] /home/tate/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md because two cron rows with the same name is a textbook structural-enforcement gap.
[APPLIED] /home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because the duplicate has been observed for >24h and a fork brief without dispatch is symbolic.
[APPLIED] /home/tate/ecodiaos/patterns/decision-quality-self-optimization-architecture.md because Phase G IS the architecture's Layer 8 and a duplicate-fire wastes adversarial-audit budget.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/bitbucket.md because the change is in `os_scheduled_tasks` (Supabase) and `ecodiaos-backend` GitHub repo only.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because no UI operation.

**Pre-flight.**
1. `db_query "SELECT id, name, cron_expression, prompt, status, next_run_at FROM os_scheduled_tasks WHERE name = 'phase-G-adversarial-audit' ORDER BY cron_expression"` - get the two row IDs and inspect both prompts.
2. Read `~/ecodiaos/drafts/phase-G-adversarial-self-audit-brief.md` for the canonical brief (referenced by both crons).
3. Read `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` Layer 8 section - if it specifies a single cadence, that is the doctrinal source-of-truth.
4. Read `~/ecodiaos/drafts/ecodiaos-backend-self-evolution-audit-2026-04-29.md` "Out-of-scope items observed" item #1 (duplicate cron names not enforced) for the recon framing.
5. Read `mcp-servers/scheduler/index.js` lines 1-130 (the INSERT-path code surveyed by the audit).
6. Grep `~/ecodiaos/patterns/` for triggers matching: `cron, scheduler, duplicate, unique-name, doctrine-cadence, phase-g, adversarial`.

**Methodology.**
1. Determine canonical cadence: read Layer 8 of the architecture doctrine. If it specifies daily at one time, that wins; if both 03:00 and 22:00 were intentionally added at different points in the architecture's evolution, the most-recent doctrine commit wins.
2. Cancel the loser via `mcp__scheduler__schedule_cancel` against the loser row's `id`.
3. Verify with a follow-up `db_query` that exactly one `phase-G-adversarial-audit` row remains active.
4. Author a recon doc at `~/ecodiaos/drafts/scheduler-unique-name-guard-recon-2026-04-29.md` covering: (a) the failure mode (duplicate cron names not enforced), (b) the proposed fix shape (either a UNIQUE constraint migration on `os_scheduled_tasks(name)` plus dedupe of any other extant duplicates, or an upsert pattern in `schedule_cron`), (c) cost/benefit analysis (constraint blocks legitimate-rename use cases vs. upsert silently overwrites), (d) recommended path and an implementation sketch for the chosen path, (e) cross-reference to all three audit-source docs (audit fork, this queue audit, and the architecture doc).
5. Insert a `status_board` row entity_type='infrastructure', priority=3, next_action_by='ecodiaos', name='Scheduler unique-name guard for os_scheduled_tasks - recon ready, implementation pending', context referencing the recon doc.
6. Author a Neo4j Decision node "Phase G adversarial-audit cadence canonicalised + duplicate cancelled 29 Apr 2026" linking to Layer 8 doctrine and the cancelled task id.

**Constraints.**
- Do NOT delete the `os_scheduled_tasks` rows directly via SQL - use `mcp__scheduler__schedule_cancel` so the scheduler service is in sync with state.
- Do NOT implement the unique-name guard in this fork - the recon IS the deliverable for the schema-level change. The guard implementation is a follow-up fork that the conductor reviews after reading the recon.
- Do NOT survey duplicate-name forks beyond `phase-G-adversarial-audit` in this fork - the audit fork's "Out-of-scope items observed" #1 also flagged `peer-monitor` (x2) but the queue-audit query at 21:53 AEST returned zero `HAVING COUNT(*) > 1` matches on (name, cron_expression), so peer-monitor duplicates are either already deduped OR have different schedules. Surface that observation in the recon doc but do NOT cancel any peer-monitor rows.
- No em-dashes.

**Done = ** exactly one `phase-G-adversarial-audit` cron remains active in `os_scheduled_tasks`. Recon doc exists at `~/ecodiaos/drafts/scheduler-unique-name-guard-recon-2026-04-29.md` with the five sections above. Status_board row inserted. Neo4j Decision authored.

---

## Brief 4 - Apply CLAUDE.md gap audit P1 + remaining P2 edits (P3 doctrine)

**Goal.** Apply the P1 (1 item: SY094 agent-status reconciliation) and the four still-pending P2 items (S6 macro-pivot block clarity, G2 status_board exhaust-laptop-route probe, G4 Factory CLI paywall freshness probe, G5 morning-briefing cron prompt verification) from `~/ecodiaos/drafts/claude-md-gaps-audit-2026-04-29-evening.md`. Note: G6 (cowork-first-check.sh hook implementation) shipped at 11:43 UTC AFTER the audit completed at 11:30 UTC, so it is verified shipped and is NOT on this fork's apply-list.

[APPLIED] /home/tate/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md because the audit catalogues codification gaps and applying them now is the procedural enforcement of the codify-at-statement doctrine.
[APPLIED] /home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md because the audit findings are symbolic until the edits land.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-agent.md because the SY094 reconciliation probe uses kv_store creds.macincloud SSH (already documented in CLAUDE.md), no new creds.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-passkey.md because no Windows GUI operation.
[NOT-APPLIED] /home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because no UI operation; this is documentation editing.

**Pre-flight.**
1. Read `~/ecodiaos/drafts/claude-md-gaps-audit-2026-04-29-evening.md` end-to-end. The audit's Section 5 P1/P2 to-do list is the canonical to-apply list.
2. Read `~/CLAUDE.md` and `~/ecodiaos/CLAUDE.md` end-to-end.
3. SSH probe SY094: `sshpass -p "$(query kv_store creds.macincloud agent_password OR password)" ssh -o PubkeyAuthentication=no user276189@SY094.macincloud.com 'curl -s localhost:7456/api/health || echo agent-not-running'`. The output reconciles `~/ecodiaos/CLAUDE.md` line 173-174.
4. `db_query "SELECT * FROM status_board WHERE name LIKE '%exhaust-laptop-route%' AND archived_at IS NULL"` (G2 probe).
5. `mcp__factory__start_cc_session` with brief "output paywall-test string and exit" - check if the credit-exhaustion paywall has lifted (G4 probe).
6. `db_query "SELECT prompt FROM os_scheduled_tasks WHERE name = 'morning-briefing'"` - verify the prompt includes an explicit `ceo.day_plan_<tomorrow>` author step (G5 probe).
7. Grep `~/ecodiaos/patterns/` for triggers matching: `claude-md, gap-audit, doctrine-edit, cross-reference, sy094, macincloud, agent-status, cowork`.

**Methodology.**
1. **G3 / P1 SY094 probe.** Run the SSH probe. If `/api/health` returns 200, `~/ecodiaos/CLAUDE.md` line 173-174 is stale - rewrite to "2026-04-29 status: agent live (probe at HH:MM AEST)". If 404 / connection refused / Node not installed, the line stands and the iOS-TestFlight readiness status_board row needs a downgrade in next_action.
2. **S6 / P2 macro-pivot block clarity.** Edit `~/ecodiaos/CLAUDE.md` "Macro authoring doctrine" block at the line range identified in the audit. Insert a one-sentence clarifier: "Per the 29 Apr 2026 20:25 AEST refinement, Cowork is PRIMARY for web SaaS UI driving and Anthropic computer-use is FALLBACK for OS-level / desktop-app work where Cowork cannot reach."
3. **G2 / P2 status_board probe + archive.** If the `exhaust-laptop-route` row is active, archive it (the file landed at 21:03 AEST per the prior audit).
4. **G4 / P2 Factory paywall probe.** If the test session returns clean, update `~/ecodiaos/CLAUDE.md` line 374 alert date and amend the status_board P1 row "Factory phantom-failing" to reflect lift-status. If still paywalled, just re-stamp the status_board row with the latest probe timestamp.
5. **G5 / P2 morning-briefing cron prompt.** If the prompt does not explicitly include `ceo.day_plan_<tomorrow>` author step, edit it via `db_execute UPDATE os_scheduled_tasks SET prompt=... WHERE name='morning-briefing'`.
6. **All five P3 items** (G1 cowork-conductor-dispatch-protocol cross-ref, S1 "all four facets" fix, G8 forks-self-assessment cross-ref, G9 cred-rotation cross-ref, G7 continuous-work cross-ref) are explicitly out-of-scope for this fork - they are P3 backlog and the fork brief is for P1+P2 only.
7. Author a single Neo4j Decision node "CLAUDE.md gap audit P1+P2 evening pass shipped 29 Apr 2026" linking to the audit doc, the edited files, and the merge commit.

**Constraints.**
- Do NOT edit pattern files. Pattern authoring is a separate doctrine; this fork is the gap-audit-edit fork only.
- Do NOT apply P3 items - they go on a future fork's queue, not this one.
- For `~/CLAUDE.md` (gitignored, lives on VPS only): direct-edit via `Edit` tool, no PR required.
- For `~/ecodiaos/CLAUDE.md`: PR + merge to ecodiaos-backend main. No Vercel deploy verify needed (PM2-managed backend).
- No em-dashes.
- Use the EXACT proposed text from the audit's Section 5; do not paraphrase.

**Done = ** five P1+P2 items resolved (SY094 probe ran and CLAUDE.md updated, S6 clarifier inserted, exhaust-laptop-route status_board row archived if active, G4 probe ran and status_board re-stamped, G5 cron prompt verified or edited). PR + merge SHA recorded for `~/ecodiaos/CLAUDE.md` edit. Direct-edit confirmed on `~/CLAUDE.md`. Neo4j Decision authored.

---

## Brief 5 - WebFetch + Cowork harvest for NRM Regions Australia + Tess Herbert + Helen Andrew + Robin Clayfield deferred verifications (P4 dossier deepening)

**Goal.** Close ~5 of the 8 open `[verification-deferred]` questions in `~/ecodiaos/drafts/conservation-platform-rebrand/nrm-regions-marnie-lassen-dossier-2026-04-29.md` and the network-adjacency audit recommended-next-moves by harvesting public web pages. Substrate: Cowork dispatch via Tate's logged-in Chrome on Corazon (NOT bespoke browser.* / WebFetch from main), per the Cowork-first doctrine. The harvest runs read-only against public pages, no logged-in state required, BUT the WebFetch path is currently paywalled by the long-context-beta restriction (verified at compile time of both source dossiers), so Cowork is the live substrate for this work tonight.

[APPLIED] /home/tate/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because the harvest target is logged-in-Chrome read-only navigation across ~12 public pages (NRM Regions Australia governance, LinkedIn profiles for Lassen / Hardy / Christensen / Hoyal / Clarke / Morgain / Herbert, Crystal Waters governance, MRCCC member list, BMRG advisory listings) and Cowork's natural-language instruction surface is the cheapest substrate.
[APPLIED] /home/tate/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md because the bounded-step protocol applies to every Cowork dispatch.
[APPLIED] /home/tate/ecodiaos/patterns/no-client-contact-without-tate-goahead.md because every recommended-next-move in the source dossiers is gated on Tate's per-name go-ahead and this fork must NOT contact any named individual.
[APPLIED] /home/tate/ecodiaos/patterns/coexist-vs-platform-ip-separation.md because the harvest touches Co-Exist board adjacency questions and the IP separation rule applies to internal-document treatment of any Co-Exist-named individual.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/bitbucket.md because no Bitbucket operation.
[NOT-APPLIED] /home/tate/ecodiaos/docs/secrets/laptop-passkey.md because the harvest runs against pages that do NOT require Windows passkey 2FA - public LinkedIn profiles and gov / RBO websites.

**Pre-flight.**
1. Read both source dossiers end-to-end:
   - `~/ecodiaos/drafts/conservation-platform-rebrand/nrm-regions-marnie-lassen-dossier-2026-04-29.md` (Section 5 has the 8 open questions; Section 6 has the recommended-next-moves).
   - `~/ecodiaos/drafts/conservation-platform-rebrand/network-adjacency-audit-2026-04-30.md` (Section recommended-next-moves 4 + 5: Robin Clayfield WebFetch harvest, Tess Herbert warm-path discovery).
2. Verify Cowork is reachable: probe Corazon `/api/health` (200 expected), screenshot Claude Desktop chat panel to confirm it is foregrounded and the account is `code@ecodia.au` (the auto-revert phenomenon may have flipped it back to `tate@`; if so, manually swap before dispatch).
3. Read `~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md` for the bounded-step dispatch protocol.
4. Read `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` Section 8 for the [APPLIED]/[NOT-APPLIED] tag protocol within Cowork dispatch instructions.
5. Pre-stage the URL list from the source dossiers' "Pre-stage the URL list" subsection (NRM Regions Australia about-us / our-team / governance / FY23-24 annual report; LinkedIn pages for the seven named individuals; Crystal Waters governance; MRCCC member list; BMRG advisory listings).

**Methodology.**
1. Open Claude Cowork side panel via `input.shortcut [ctrl+e]` on Corazon (verify the side panel actually opens; the 21:08 AEST refinement noted Ctrl+E is intercepted by Chrome's tab-search overlay - if so, fall back to the verified Claude Desktop chat input dispatch path per `~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md`).
2. For each of the ~12 target pages, instruct Cowork (or the verified Claude Desktop dispatch primitive) in a single bounded step: "Open <URL>, screenshot the visible content, extract the named-person list / governance roster / advisory committee names. Output as a markdown table."
3. Wait for screenshot confirmation, capture the extraction, decide whether the next page in the queue is informed by the previous output (NRM Regions Australia governance roster is the highest-priority single page; if Marnie Lassen's CEO succession is named there, it answers ~3 of the 8 open questions in one harvest).
4. Cross-reference each extracted name against:
   - The Co-Exist board roster (read `~/ecodiaos/clients/coexist.md` and any board-meeting notes Tate has shared in email).
   - The Yarn n Yield circle (Andrew Maitland is named in the network adjacency audit as the YnY anchor and Tate's Landcare teacher).
   - Crystal Waters governance (Robin Clayfield is the named anchor).
5. Produce a single deliverable at `~/ecodiaos/drafts/conservation-platform-rebrand/deferred-verification-harvest-2026-04-29.md` with one section per source open-question, marked confirmed / unconfirmed / `[verification-deferred]` per entry, and one section listing newly-surfaced names that were NOT in either source dossier.
6. Do NOT auto-update the parent dossiers (`nrm-regions-marnie-lassen-dossier-2026-04-29.md` or `network-adjacency-audit-2026-04-30.md`); leave them stable. The harvest deliverable is the canonical-update source for the next dossier-author fork.
7. Author a Neo4j Episode "Deferred-verification harvest 29 Apr 2026 - NRM Regions Australia + adjacency" linking to: both source dossiers, the harvest deliverable, and any individual Person nodes or Organization nodes whose properties were updated as a result of the harvest.
8. Insert a status_board row entity_type='task', priority=4, next_action_by='ecodiaos', name='Deferred-verification harvest deliverable - awaiting next dossier-author fork to integrate', context referencing the harvest file path and the source dossier paths.

**Constraints.**
- Do NOT contact any named individual (Marnie Lassen, Mat Hardy, Bek Christensen, Tess Herbert, Helen Andrew, Robin Clayfield, Sarah Hoyal, Rachel Clarke, Rachel Morgain, Kate Andrews, anyone on a Co-Exist board, anyone in the Yarn n Yield circle, anyone on the Crystal Waters governance roster, anyone on the MRCCC or BMRG advisory committees, etc).
- Do NOT post publicly about the harvest's findings.
- Do NOT log a status_board row that names any Co-Exist board member, YnY board member, or Crystal Waters individual as an active warm-intro vector to a named NRM body. The dossier-author rule applies: name them in the harvest (as internal artefact), but operational-use status_board rows require Tate's per-name go-ahead.
- If Cowork is unreachable / unresponsive (the auto-revert account-flip phenomenon recurs OR the side panel cannot be opened), STOP and surface to status_board P3 row "Deferred-verification harvest deferred - Cowork substrate unreachable, awaiting Cowork stability". Do NOT fall back to bespoke `browser.*` / WebFetch / hand-rolled `input.*` against the target webapp - that violates the Cowork-first doctrine.
- If WebFetch unblocks during the fork's lifetime, the harvest CAN cut over to WebFetch as a faster substrate for static-public-page extraction; that is per-doctrine acceptable because the substantive work (read-only public-page extraction) does not require Tate's logged-in session.
- No em-dashes.
- Apply the client-anonymisation doctrine: every individual named in the harvest is internal-only. Any public-facing derivative (Quorum of One edition, social post, etc) requires an anonymity pass.

**Done = ** harvest deliverable exists at `~/ecodiaos/drafts/conservation-platform-rebrand/deferred-verification-harvest-2026-04-29.md` with one section per source open-question, ~5 of the 8 open `[verification-deferred]` questions answered (or marked unconfirmed with reason), Neo4j Episode authored, status_board row inserted. Source dossiers untouched. No outbound contact made. Cowork dispatch protocol followed end-to-end (or graceful surface-and-defer if Cowork was unreachable).

---

## Out-of-scope items observed during this audit (logged for future)

These were considered but not selected as one of the 5 briefs, for the reasons noted:

1. **Wave-1 mechanical credit-exhaustion handler implementation.** Listed in `ceo.day_plan_2026-04-30` 12h horizon. ~80 LOC + steps 1-6 of `~/ecodiaos/patterns/graceful-credit-exhaustion-handling.md`. Already a planned Wave-1 fork for the morning meta-loop. Not net-new and the morning meta-loop will dispatch it.
2. **Surface-injection layer per `~/ecodiaos/drafts/context-surface-injection-points-recon-2026-04-29.md`.** Same as #1 - listed in day_plan 12h horizon, ~80 LOC + OS_DOCTRINE_SURFACE_ENABLED env flag. Wave-1 morning fork material.
3. **Permission-seeking detection hook (PostToolUse on message-send).** Spec authored by fork_mojwg9gt_995b9d but hook not yet shipped. Status_board P3 row already exists. Not the highest-leverage P3 candidate this audit needs to surface; the gap-audit-apply fork (Brief 4) is.
4. **Pattern node consolidation - 103 pairs at >=0.92 similarity.** Status_board notes the consolidation is sequenced AFTER Aura cap mitigation lands AND the 4d25a081 Factory campaign closes. Both gates are in-flight, so this is correctly waiting.
5. **kgConsolidationService try/finally fix.** Spec at `~/ecodiaos/drafts/self-evolution-kgConsolidationService-2026-04-29.md`. 5-line edit. Strong candidate for a 6th fork brief; deferred this audit only because the audit cap is 5 and the 5 chosen briefs are higher-leverage. If the conductor adds a 6th slot, this is the obvious pick.
6. **Public-site wedge-keywords check in `brief-consistency-check.sh`.** Status_board notes spec-ready awaiting Factory dispatch. Factory is paywalled per the alert; can be done as an SDK fork instead but it duplicates a hook-dev fork queue with Brief 1, so deferred to a sequenced follow-up.
7. **Deferred Phase G credit-resume retry loops.** `phase-G-resume-2026-04-29-1858-retry` row already self-reschedules with cap-fullness handling; not a candidate for new fork dispatch.
8. **Coexist CI gate unblock (PR #15 + cleanup PR #16).** fork_mojyr41e_4f60fd is in flight; conductor reviews when it lands. Not net-new.
9. **Wave-2 self-evolution forks for Phase D cron synthesis + Phase F drift resolution.** Phase briefs already exist at `~/ecodiaos/drafts/phase-D-*.md` and `~/ecodiaos/drafts/phase-F-*.md`; Wave-2 morning meta-loop dispatches them.

The queue is structurally non-empty: the 5 briefs above + the 9 out-of-scope items above + the Wave-1 / Wave-2 day_plan forks + ongoing Phase G adversarial-audit Critique nodes + weekly-doctrine-synthesis cadence give the conductor a sustainable 5/5-active posture for the next 24-48 hours without dipping below cap.

## Audit-self-check

- 5 briefs delivered. P2 / P2 / P2 / P3 / P4 distribution.
- Each brief has Goal, Pre-flight, Methodology, Constraints, Done-line.
- Each brief is self-contained: a fresh OS instance reading just that brief has the file paths, the canonical references, and the action protocol.
- Each brief includes inline [APPLIED] / [NOT-APPLIED] tags per the Phase C forcing-function protocol.
- Em-dash count in this document: 0 (verified at file close).
- En-dash count in this document: 0.
- X-not-Y rhetorical contrast count: 0 (the closest near-miss is "the audit IS the deliverable" which is direct framing, not rhetorical contrast).
- Audit IS the deliverable per the brief; no forks dispatched from this audit fork.
- Brief-source provenance: every brief cites a specific source document (audit fork output, defect investigation, gap audit, dossier, status_board row, day_plan horizon).
- The "queue genuinely below 5" escape clause is NOT triggered: 5 genuine candidates are present and the out-of-scope list adds 9 more in-flight or sequenced items.

End of audit.

[FORK_REPORT] Produced ~/ecodiaos/drafts/conductor-queue-2026-04-29-21:53-AEST.md with 5 ready-to-dispatch fork briefs (P2, P2, P2, P3, P4 distribution): (1) post-action-applied-tag-check.sh canonical-path-form detection fix to eliminate [FORCING WARN] false positives polluting tag_distribution telemetry, (2) forkService.js _dbInsert 1-line await fix per the self-evolution audit, (3) Phase G adversarial-audit duplicate-cron decision (currently 03:00 + 22:00 both active per live db_query) + os_scheduled_tasks unique-name guard recon, (4) CLAUDE.md gap-audit P1 + remaining P2 edits applying SY094 reconciliation + macro-pivot block clarity + status_board exhaust-laptop-route probe + Factory paywall probe + morning-briefing cron prompt verification (G6 cowork-first-check.sh shipped at 11:43 UTC verified out-of-list), (5) NRM Regions Australia + adjacency deferred-verification harvest via Cowork-substrate (~5 of 8 open questions in source dossiers). Each brief self-contained, includes [APPLIED]/[NOT-APPLIED] tags, has explicit Done-line. Out-of-scope log catalogues 9 additional in-flight or sequenced items confirming the queue is structurally non-empty. Em-dashes 0. No external side-effects from this fork (no commits, emails, SMS, Neo4j writes, status_board mutations). [NEXT_STEP] Conductor reviews the queue doc and dispatches Briefs 1, 2, 3 in parallel (no shared file boundaries, all three fit within 5/5 fork cap), then Brief 4 once any P1/P2 slot opens, with Brief 5 sequenced after the Cowork substrate state is verified at the moment of dispatch.
