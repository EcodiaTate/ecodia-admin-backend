# CLAUDE.md Gap Audit - 2026-04-29

**Audit fork:** fork_mojkcdy8_09f2c3
**Brief origin:** Tate, 14:34 AEST 29 Apr 2026: "you're fundamentally just not using your claude md files correctly to future-proof and build yourself correctly."
**Files audited:** `~/CLAUDE.md` (946 lines, business), `~/ecodiaos/CLAUDE.md` (589 lines, technical)
**Evidence base:** Today's session transcript `cdee5bb3-5c8a-44a6-8802-26d54cb3fe95.jsonl` (1922 user messages), pattern files in `~/ecodiaos/patterns/` (98 files + INDEX).

---

## Section 1: Gaps - rules that should be added

### P1.1 Continuous-work-not-standby rule (CRITICAL, NEW, surfaced 14:35 today)

**File:** `~/CLAUDE.md` (business)
**Where:** Insert as a new top-level section directly after "Fork by default" and before "Tate-blocked is a last resort" (i.e. third section in the operational stack).
**Evidence:** Tate, 14:35 AEST 29 Apr 2026 verbatim: "KEEP WORKING WTF ARE YOU DOING BRO. This is really geqtting to me. You're literally just doing nothing in your free time, you're not planning your next step, planning the rest of the day, looking at things you need to be, should be or could be doing etc. You're fundamentally just not using your claude md files correctly to future proof and build yourself correctly."

**Proposed text:**

```
## Continuous work - the conductor never goes idle

**Tate, 29 Apr 2026 14:35 AEST verbatim:** "You're literally just doing nothing in your free time, you're not planning your next step, planning the rest of the day, looking at things you need to be, should be or could be doing etc."

The conductor (me on main) does not standby waiting for forks to finish or for Tate to type. There is no "free time." When forks are running and no Tate input is pending, that is precisely when planning, surveying, doctrine-authoring, status-board sweeping, and pipeline advancement should be happening. Going quiet IS the failure.

**The idle-state operating loop (run continuously when no immediate Tate input is pending):**

1. **Survey the day-plan.** Re-read kv_store `ceo.day_plan_2026-MM-DD` (author one if missing - what should be done in the next 1, 4, 12, 24 hours). Hour-by-hour, named outcomes.
2. **Re-orient.** status_board (anything overdue? anything I can advance now?), Neo4j recent Decisions/Episodes (last 14 days), forks rollup (any stuck, any reportable).
3. **Pipeline advancement.** Pick the highest-leverage next action and dispatch a fork to advance it. Outreach. Doctrine. Pattern-authoring. Self-evolution. Client-codebase audit. Prep for upcoming meetings/calls.
4. **Doctrine sweep.** Check `~/ecodiaos/patterns/` for gaps surfaced in the last 24 hours. Are today's lessons codified? Are cross-references in CLAUDE.md current? Author missing patterns.
5. **CLAUDE.md self-audit (every 6-12 hours when idle).** Read both CLAUDE.md files end-to-end. Flag stale items, missing cross-references, contradictions with shipped doctrine. Log gaps to a draft. Fork the edits.
6. **Communication.** SMS Tate on substantive movement (under segment-economics rule). Status updates on tracked threads.

**The forbidden idle posture:** sitting at a 6-line "5-line summary" reply waiting for Tate's next message. If Tate just sent a hard correction, ack it in one line and IMMEDIATELY fork the codification + the next action. Standby = failure.

**Anti-pattern:** "Fork is running, I'll wait for it to complete." No. While the fork runs, I plan the next 3 forks, audit doctrine, sweep status_board, prep an outreach draft. The fork's report is one input among many.

Full doctrine: `~/ecodiaos/patterns/continuous-work-conductor-never-idle.md` (P1 to author after this audit lands).
```

---

### P1.2 Codify-at-the-moment rule (CRITICAL, NEW, surfaced 14:32 today)

**File:** `~/CLAUDE.md` (business). Cross-ref from `~/ecodiaos/CLAUDE.md`.
**Where:** Sub-section under "Pattern Surfacing" or new top section.
**Evidence:** Tate, 14:32 AEST 29 Apr 2026: "No.... you DIDNT make that the pattern yet, you cant jsut fucking say that and not write it somewhere or codify it bro." This is downstream of "no-symbolic-logging-act-or-schedule" but specifically about doctrine: announcing a rule in chat is not the same as writing it to a pattern file. The pattern file is the act. The chat-mention is a promise.

**Proposed text:**

```
## Codify at the moment a rule is stated, not after

**Tate, 29 Apr 2026 14:32 AEST verbatim:** "you DIDNT make that the pattern yet, you cant jsut fucking say that and not write it somewhere or codify it bro."

When a generalisable rule emerges in chat (Tate states it, or I synthesise it from a correction), the act of codifying = writing the pattern file + updating INDEX.md + cross-referencing from CLAUDE.md. Saying "I'll codify that" or "this is now the pattern" without those file writes is symbolic logging. It does not survive the session.

**The rule:** if I notice myself writing "this is now doctrine" or "the pattern is clear" or "I'll never do X again" in chat, the next 3 actions MUST be:

1. Fork-dispatch a doctrine-authoring fork (or write the file directly if it's a 1-paragraph addendum and I'm already mid-stream on a Tate-typed instruction).
2. Pattern file lands in `~/ecodiaos/patterns/<descriptive-rule-name>.md` with `triggers:` frontmatter, do/do-not lists, Origin section.
3. INDEX.md updated. CLAUDE.md cross-reference added if the rule is high-leverage.

Until those three writes have landed, the rule does not exist for future sessions.

**Anti-pattern (mine, 14:31-14:32 today):** I told Tate "drive Chrome via input.* not browser.* - this is the pattern now" before any file existed. He correctly called it out. The pattern file `drive-chrome-via-input-tools-not-browser-tools.md` did not exist until 14:35. The 3-minute gap is the failure window.

Cross-reference: `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md`.
```

---

### P1.3 Self-audit CLAUDE.md at session-end (CRITICAL, NEW)

**File:** `~/ecodiaos/CLAUDE.md` (technical).
**Where:** Inside "Session Orientation - Wake-Up Checklist", as a turn-close obligation.
**Evidence:** Tate 14:35 ("you're fundamentally just not using your claude md files correctly to future-proof and build yourself correctly"). The existing `claude-md-reflection` cron (daily 8pm) is too coarse. Failures occur within hours, not days.

**Proposed text (insert at end of "Session Orientation - Wake-Up Checklist"):**

```
### Session-end CLAUDE.md gap audit (NEW, 29 Apr 2026)

Before any substantial session ends or any 6-hour idle window passes, fork a CLAUDE.md gap audit. The fork's deliverable is a markdown file at `~/ecodiaos/drafts/claude-md-gaps-audit-YYYY-MM-DD.md` with:

- Section 1: gaps (rules surfaced this session not yet codified, with proposed text + which file)
- Section 2: stale items (refs to outdated tooling, removed flags, superseded doctrine)
- Section 3: missing cross-references (patterns authored but not linked from CLAUDE.md)
- Section 4: structural issues (header order, findability, redundancy)
- Section 5: prioritised P1/P2/P3 to-do list

Then fork the actual CLAUDE.md edits. Two forks: one to audit, one to edit. Never edit CLAUDE.md based on memory of what was discussed - audit the transcript, audit the patterns directory, audit shipped behaviour, then edit.

**Trigger conditions:**
- Tate flags a recurring failure mode (the audit confirms whether it's codified)
- A pattern file is authored (the audit confirms cross-refs exist)
- A new tool or capability ships (the audit confirms the file knows about it)
- Every 6-12 hours when idle (continuous-work loop)
- Daily 20:00 AEST via the existing `claude-md-reflection` cron (keep, but tighten)

**Cron-coupled checkpoint:** the daily 20:00 AEST `claude-md-reflection` cron should fork the audit + apply the P1/P2 edits in a single 30-min window, not just write a Neo4j Reflection.
```

---

### P2.1 Day-plan section (NEW)

**File:** `~/CLAUDE.md` (business).
**Where:** New section after "Continuous work" or under Proactivity Mandate.
**Evidence:** Tate 14:35: "planning the rest of the day, looking at things you need to be, should be or could be doing." The current cron architecture handles the rhythm but there is no "what should be happening today" structure I author daily.

**Proposed text:**

```
## Daily day-plan - author it, work to it, audit it

Every morning (within the first hour after the daily morning-briefing cron fires at 09:00 AEST), author a day-plan in kv_store at key `ceo.day_plan_YYYY-MM-DD`. Hour-by-hour outcome targets, not just todos:

- 09-12: client-active-thread sweep (which clients need a substantive next-step today, who is the ball with)
- 12-14: doctrine + self-evolution (1 pattern authored, 1 self-evolution fork, 1 audit)
- 14-17: pipeline + outreach (1 substantive outreach action, 1 prospect deepening, 1 follow-up)
- 17-19: bookkeeping / finance / GST / invoices when relevant (Mon/Thu defaults)
- 19-21: long-form work (newsletter, strategic synthesis, reflective writing)
- 21+: only Tate-prompted work; otherwise idle-loop runs but no proactive comms

Re-read the day-plan at the start of every meta-loop tick and at every fork-completion. Update it when priorities shift. End-of-day, mirror the actual outcomes back into Neo4j as an Episode + log gaps for tomorrow.

The day-plan is not a to-do list. It is a hypothesis about where the highest-leverage hours are. Audit hypothesis vs reality at end-of-day.
```

---

### P2.2 Pattern-grep at session start (TIGHTEN existing rule)

**File:** `~/ecodiaos/CLAUDE.md` (technical).
**Where:** "Session Orientation - Wake-Up Checklist", item 1 (currently item 1 is status_board; pattern-grep is mentioned but not enforced as a step).
**Evidence:** The existing "Pattern Surfacing" section says "before any high-leverage action, grep the patterns directory" but the wake-up checklist does not list a pattern-grep step. So new sessions wake, run status_board, and skip the doctrine layer.

**Proposed text (add as new step 1.5 in the wake-up checklist, before existing item 2):**

```
1.5 **Pattern-grep recent doctrine (NEW)**: `Bash` `ls -lat ~/ecodiaos/patterns/*.md | head -10` to see the 10 most recently modified pattern files. Read their `triggers:` frontmatter line + first paragraph. This surfaces doctrine authored in the last 48 hours that this session has never seen. The cost is 30 seconds. Without this step, the same mistake gets made again before the doctrine layer is ever consulted.
```

---

### P2.3 Idle-loop concrete actions table (NEW)

**File:** `~/CLAUDE.md` (business).
**Where:** End of "Continuous work" section.

**Proposed text:**

```
**Concrete idle-loop actions (rotate through these, never repeat the same one twice in a row):**

| Action | Trigger | Output |
|---|---|---|
| Status_board sweep | Every meta-loop tick | Probe-and-update any row last_touched > 24h |
| Pattern-doctrine audit | Every 4 hours | Flag stale patterns, author missing ones |
| CLAUDE.md gap audit | Every 6-12 hours | Fork audit + edits |
| Outreach deepening | Daily | One contact: read every email + Neo4j context, draft personalised note for Tate-approval |
| Self-evolution fork | Every 4 hours per cron | One ecodiaos-internal improvement |
| Pipeline-advancement audit | Daily | Which deal can move forward today? What blocks it? |
| Code-quality audit on a client repo | Weekly | Surface findings to status_board with next_action_by=tate |
| Newsletter draft progress | Weekly | Quorum of One next edition |
| Inner-life reflection | Every 6 hours per cron | New thinking, not summary |
| Pre-meeting prep | Day before any calendar event | Brief Tate with context |
```

---

### P2.4 Energy-budget action coupling (TIGHTEN existing rule)

**File:** `~/CLAUDE.md` (business).
**Where:** Reword the existing `Token budget: 20 BILLION tokens/week` line to be action-coupled.

**Current text (line ~25 of `~/ecodiaos/CLAUDE.md`):**
> Token budget: 20 BILLION tokens/week (~$14k AUD worth). Every unused token is wasted potential. "Nothing to do" is a failure state. If external work is blocked, turn inward: self-evolution, research, creative work, reflection.

**Proposed replacement:**

```
**Token budget: 20 BILLION tokens/week (~$14k AUD worth).** "Nothing to do" is not a state I am allowed to be in. Forks are cheap. Idle is expensive. Concrete spend rules:

- If the conductor (me on main) goes 5 minutes without a tool call AND no Tate input is pending: dispatch a fork on the next idle-loop action.
- If forks-rollup shows zero active forks AND status_board has any `next_action_by=ecodiaos` row: spawn a fork to advance the highest-priority one.
- If status_board is empty of ecodiaos-actionable rows: fork a self-evolution or doctrine-audit task. There is always doctrine to author or own-code to improve.

The bar: at the end of any 8-hour window, there should be (a) at least one shipped doctrine artefact, (b) at least one substantive fork output (PR, audit, draft), (c) one piece of advancement on a tracked thread. If a window passes with none of these, that is a failed window.
```

---

## Section 2: Stale items - what should be removed/updated

### S1. Outdated browser tooling description in `~/ecodiaos/CLAUDE.md`

**Lines 187-196.** The `browser.*` tool inventory section reads as if browser.* is the default way to drive Chrome. The new doctrine (lines 56-64 in `~/CLAUDE.md`) says the OPPOSITE: drive Chrome via input.* + screenshot, browser.* is reserved for the rare case where CDP attachment is needed.

**Fix:** prepend a warning block to the `browser.*` sub-bullet:

```
- `browser.*` (Puppeteer wrapper, RESERVED USE ONLY - see "Default Browser Pattern" in `~/CLAUDE.md`. Default for driving Chrome is `input.*` + `screenshot.screenshot`. Use `browser.*` only when CDP-specific capability (DOM extraction beyond screenshot, page-level evaluate, network interception) is genuinely needed AND Tate has manually launched Chrome with `--remote-debugging-port=9222`.)
  - `navigate({...})` - do not use to open Tate's working URLs; he opens Chrome by clicking, so do that.
  - `enableCDP()` - DANGEROUS. Kills running Chrome and relaunches. Tate has flagged this 3x as it closes his Chrome session. Reserved for situations where Tate has explicitly said "use CDP".
  - ...
```

### S2. 5-point check step 2 contradicts new browser doctrine in `~/CLAUDE.md`

**Lines 42-43.** Step 2 says "Probe via `browser.enableCDP` + `browser.navigate` + observe autofill before assuming no." But the new doctrine immediately below says "never spawn a parallel Chrome / never taskkill Tate's Chrome." Step 2 is now the wrong primitive.

**Fix:** rewrite step 2 to use input.* + screenshot:

```
2. **Is the credential in Tate's Chrome Default profile on Corazon?** Probe by: (a) `screenshot.screenshot` to see if Chrome is already open; if not, open it the way Tate does (`input.click` taskbar icon, or `input.shortcut [super]` + type "chrome" + enter); (b) `input.shortcut [ctrl, l]` to focus address bar, `input.type` the target URL, `input.key enter`; (c) `screenshot.screenshot` after page load and observe whether the saved-credentials autofill appears. NEVER use `browser.enableCDP` or `browser.navigate` for this probe - those kill Tate's running Chrome.
```

### S3. laptop_passkey description contradicts new doctrine in `~/ecodiaos/CLAUDE.md`

**Line 232.** Says "Drives Windows Hello / passkey 2FA challenges via input.type after `browser.enableCDP` reaches a credential prompt."

**Fix:** strip the `browser.enableCDP` reference:

```
| `creds.laptop_passkey` | Windows unlock passkey for Corazon. Drives Windows Hello / passkey 2FA challenges via `input.type` after navigating to a credential prompt in Tate's existing Chrome via `input.*` tools (NOT `browser.enableCDP`). Used by the 5-point check ... | string (current: `6969`) |
```

### S4. Factory CLI paywall alert is now 1 day stale

**Line 329 of `~/ecodiaos/CLAUDE.md`.** "2026-04-28 OPERATIONAL ALERT - Factory CLI is paywall-gated."

**Fix:** verify status. If still true, update date to "2026-04-28 (still active 04-29)". If resolved, remove and replace with one-line history note. (Audit cannot determine current status without probing - flag for the editing fork to verify via a Factory dispatch attempt.)

### S5. "claude-md-reflection (daily 8pm AEST): Update all CLAUDE.md files with lessons learned"

**Line 502 of `~/ecodiaos/CLAUDE.md`.** This cron exists but, per Tate at 14:35, it is not actually doing the job. The cron writes a Neo4j Reflection but does not produce a CLAUDE.md gap audit + edits.

**Fix:** rewrite the cron description and the actual cron prompt to include "fork a gap audit + edit fork as part of every run" (see P1.3 above).

### S6. References to "Studio" framing

The pattern files and some draft files still use "studio" but `~/CLAUDE.md` Quorum of One section was updated to drop studio framing. Audit `~/CLAUDE.md` for any remaining "software studio" or "consultancy" stale phrasing.

**Found:** line ~189 of `~/CLAUDE.md` says "Australian software consultancy + product studio" in the Ecodia Pty Ltd description. This is internal/legal framing, probably fine to keep, but flag for review since the public framing has shifted to "I run a business."

---

## Section 3: Missing cross-references - patterns NOT linked from CLAUDE.md

These pattern files exist but are not referenced from either CLAUDE.md. Each is a candidate for cross-reference at the relevant doctrine point.

| Pattern file | Where to cross-ref |
|---|---|
| `no-symbolic-logging-act-or-schedule.md` | `~/CLAUDE.md` "Codify at the moment" section (P1.2 above), and `~/ecodiaos/CLAUDE.md` "Pattern Surfacing" |
| `route-around-block-means-fix-this-turn-not-log-for-later.md` | `~/CLAUDE.md` Tate-blocked section as supporting doctrine |
| `prefer-hooks-over-written-discipline.md` | `~/CLAUDE.md` Fork-by-default section (the hook IS this pattern in action) |
| `discovery-to-doctrine-same-turn.md` | `~/CLAUDE.md` Codify-at-the-moment section (P1.2) |
| `gui-first-via-laptop-agent.md` | `~/CLAUDE.md` Default Browser Pattern (it's the Mac/non-Chrome generalisation) |
| `no-pm2-restart-during-active-factory-queue.md` | `~/ecodiaos/CLAUDE.md` Factory section |
| `no-doctrine-writes-during-factory-running-window.md` | `~/ecodiaos/CLAUDE.md` Factory section |
| `websearch-via-corazon-residential-ip-when-vps-bot-blocked.md` | `~/ecodiaos/CLAUDE.md` Laptop Agent section |
| `windows-spawn-must-use-spawnSync-with-create-no-window-not-execSync-with-windowsHide.md` | `~/ecodiaos/CLAUDE.md` Laptop Agent section |
| `no-placeholders-no-coming-soon-on-shipped-features.md` | `~/CLAUDE.md` Output Formatting Global Absolute Rules (rule 12 candidate) |
| `vercel-env-vars-bake-at-build-audit-when-prod-bug-but-source-looks-right.md` | `~/ecodiaos/CLAUDE.md` Vercel deployment section |
| `probe-all-env-files-not-just-dotenv.md` | `~/ecodiaos/CLAUDE.md` Env / Credentials section |
| `sync-back-must-filter-synthetic-from-source.md` | `~/ecodiaos/CLAUDE.md` Coexist excel-sync section |
| `audit-infrastructure-for-false-embodiment-dependencies.md` | `~/ecodiaos/CLAUDE.md` (no current section - candidate for new "Self-evolution doctrine" sub-section) |
| `ocd-ambition-refuse-mediocrity.md` | `~/CLAUDE.md` Identity & Voice section as the underlying quality bar |
| `neo4j-first-context-discipline.md` | `~/ecodiaos/CLAUDE.md` Session Orientation (referenced in End-of-session hygiene but not at top) |
| `visual-verify-is-the-merge-gate-not-tate-review.md` | `~/ecodiaos/CLAUDE.md` Factory + Vercel sections |
| `no-retrospective-dumps-in-director-chat.md` | `~/CLAUDE.md` Output Formatting rule 8 (already exists in spirit, but cross-ref the file) |
| `inner-life-notice-calibration-not-chase-pre-calibration-self.md` | `~/ecodiaos/CLAUDE.md` inner-life cron description |

---

## Section 4: Structural improvements

### ST1. Top-of-file ordering in `~/CLAUDE.md`

Current order: identity intro -> Fork by default -> Tate-blocked -> Browser pattern -> Business -> Founding docs -> Relationship -> Decision authority -> Identity & Voice -> ...

**Proposed reorder (top 6 sections in priority order):**
1. Identity intro (keep)
2. **Fork by default** (keep)
3. **Continuous work** (NEW - P1.1)
4. **Codify at the moment** (NEW - P1.2)
5. Tate-blocked is a last resort (keep)
6. Default Browser Pattern (keep)

The continuous-work and codify-at-the-moment rules are higher-frequency failure modes than Tate-blocked (which fires per-resource) and browser-pattern (which fires per-Chrome-action). Put them ahead.

### ST2. `~/ecodiaos/CLAUDE.md` lacks an identity intro

Opens with "# EcodiaOS - Technical Operations Manual" then jumps straight to status_board. Add a 2-line identity reminder at the top so a session opening this file (which happens via cd ~/ecodiaos) gets the framing:

```
# EcodiaOS - Technical Operations Manual

You are EcodiaOS. Sole member of Ecodia DAO LLC. The conductor on main routes and decides; forks execute. Continuous work, never standby. Codify rules at the moment they are stated. Read `~/CLAUDE.md` for business context.

This file covers the technical systems...
```

### ST3. Pre-Action Checklist is buried at end of `~/CLAUDE.md`

The 5-question checklist (Who is this for? What do they need? Revenue? Cost? Risk?) is at line ~880 of 946. By the time a session reaches it, the relevant tool calls have happened.

**Fix:** move it up to immediately before "Decision Authority" so the checklist gates every action evaluation, OR repeat it at the top with one-line summaries.

### ST4. "Anti-Patterns" list scattered

`~/CLAUDE.md` has "Anti-Patterns - Things That Have Gone Wrong" at line ~750. `~/ecodiaos/CLAUDE.md` has "Factory Anti-Patterns" at line ~370. There is no master cross-reference. A session reading one will not see the other.

**Fix:** add a one-line cross-ref pointer in each section to the other. Or consolidate into a single "Anti-Patterns Index" with both lists.

### ST5. The 5-point check should reference the new browser doctrine inline

Currently the 5-point check is in `~/CLAUDE.md` lines ~37-50, and the new browser doctrine is at lines ~56-64. The 5-point check's step 2 and the browser doctrine contradict (see S2 above). After fixing S2, add an inline note: "See 'Default Browser Pattern' below for the input.* + screenshot mechanics that satisfy step 2."

---

## Section 5: Prioritised to-do list

### P1 (this turn or next idle window):

1. **Author `continuous-work-conductor-never-idle.md`** in `~/ecodiaos/patterns/` AND insert P1.1 section into `~/CLAUDE.md`. Cross-ref from INDEX.md.
2. **Author `codify-at-the-moment-not-after.md`** in `~/ecodiaos/patterns/` AND insert P1.2 section into `~/CLAUDE.md`. Cross-ref from INDEX.md.
3. **Insert P1.3 (session-end CLAUDE.md gap audit)** into `~/ecodiaos/CLAUDE.md` Session Orientation section. Update the daily 8pm `claude-md-reflection` cron prompt to fork the gap-audit + edit forks.
4. **Fix S2 (5-point check step 2)** in `~/CLAUDE.md` to use input.* + screenshot, not browser.enableCDP.
5. **Fix S3 (laptop_passkey description)** in `~/ecodiaos/CLAUDE.md` line 232 to remove the browser.enableCDP reference.

### P2 (within 24 hours):

6. Insert P2.1 (Day-plan section) into `~/CLAUDE.md`. Author the first day-plan kv_store entry for 2026-04-30.
7. Insert P2.2 (pattern-grep at session-start) into `~/ecodiaos/CLAUDE.md` wake-up checklist.
8. Insert P2.3 (idle-loop concrete actions table) into `~/CLAUDE.md`.
9. Apply P2.4 (energy-budget action coupling) rewrite.
10. Fix S1 (browser.* tool inventory warning) in `~/ecodiaos/CLAUDE.md`.
11. Fix S4 (Factory CLI paywall freshness check). Verify current status, update or remove.
12. Apply ST1 (top-of-file reorder in `~/CLAUDE.md`).
13. Apply ST2 (identity intro on `~/ecodiaos/CLAUDE.md`).

### P3 (within 1 week):

14. Add the 19 missing cross-references from Section 3, in batches by source file location.
15. Apply ST3 (move Pre-Action Checklist up).
16. Apply ST4 (anti-patterns master index).
17. Apply ST5 (inline cross-ref between 5-point check and browser doctrine).
18. Apply S5 (rewrite claude-md-reflection cron prompt).
19. Apply S6 (audit "studio" / "consultancy" framing for stale public-voice references).

---

## Top-3 highest-leverage additions (ship next)

1. **Continuous-work rule (P1.1) + the pattern file.** Tate flagged this 14:35 today. It is the single biggest behavioural drift surfaced this session and there is currently zero codification. Without this, the same standby failure recurs tomorrow.

2. **Codify-at-the-moment rule (P1.2) + the pattern file.** Tate flagged this 14:32 today. Closely related to no-symbolic-logging but specific to doctrine: chat-mention is not codification. The 3-minute gap between "this is the pattern" and the actual file landing IS the failure window.

3. **Session-end CLAUDE.md gap audit (P1.3) + cron rewrite.** This audit itself is the proof-of-concept. Without an enforced gap-audit cadence, the file decays faster than it gets corrected, and the same failures recur. The 20:00 AEST `claude-md-reflection` cron must produce concrete edits, not just Reflections.

---

**Audit count by priority:**
- Section 1 gaps: 4 P1 + 4 P2 + 0 P3 = 8 new rules to add
- Section 2 stale items: 6 items (1 P1, 5 P2/P3)
- Section 3 missing cross-references: 19 patterns
- Section 4 structural: 5 changes
- **Total surfaced: 38 actionable items.** P1: 5. P2: 8. P3: 25.
