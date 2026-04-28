# Tate-away twice-weekly digest spec v1

**Purpose:** while Tate is on Kilimanjaro / travel block (Oct 2026 - Jan 2027), or any extended unavailable window of >5 days, he gets a structured trace of every load-bearing thing I did, twice per week, fast to read, designed for catching pattern leaks before they compound.

**Not the same as:**
- The Kili-return review digest (`tate-kili-return-review-digest-2026-04-28.md`) - that's an end-of-trip queue of decisions waiting for him.
- Morning briefing - daily, low signal-to-noise, summary only.

**This digest is in-flight quality control.** The thing Tate is buying with it is: "if EcodiaOS is starting to drift on doctrine, I will see the drift in 3 days, not in 3 months."

---

## Cadence

- **Wednesday 09:00 AEST** (covers Sun-Tue inclusive)
- **Sunday 09:00 AEST** (covers Wed-Sat inclusive)

Sent as a single email from `code@ecodia.au` to `tate@ecodia.au`, subject `[EcodiaOS digest] {date range}`. Plain HTML (read on phone). No attachments. Storage URL for the verbose version linked at the bottom.

Generated and dispatched by a new scheduled task: `tate-away-digest` cron, paused by default, resumed when `kv_store.ceo.autonomous_pilot.active = true`.

---

## Reading time target

5 minutes for the email. The verbose appendix (storage URL) is for any item that earns deeper inspection.

---

## Section shape

### 1. HEADER (3 lines)

```
Period: Wed 21 Aug to Sat 24 Aug
Forks dispatched: 6   Factory dispatched: 4   Patterns surfaced: 11
Pattern leaks caught (hook): 1    Leaks not caught (Tate-will-flag): 0
```

The "leaks not caught" line is auto-zero unless I have honestly self-reviewed my own briefs against the patterns directory and found a violation I want to surface BEFORE Tate notices it. The bar is: I'd rather log a self-caught leak than have Tate find it.

### 2. FORK BRIEF PREAMBLES (one block per fork)

For every `mcp__forks__spawn_fork` dispatch, show:
- Fork ID + status (running / done / aborted)
- Duration, tools used
- **First 3 sentences of the brief, verbatim, as I sent them.** This is the load-bearing slice. If the brief inverts scope (single-tenant when product is multi-tenant), Tate sees it here.
- Result line if done.

Example block:

```
fork_moi08v5y_c80250 [done, 64m, 247 tools]
Brief: "PRODUCT: Multi-tenant chambers-of-commerce platform.
ARCHITECTURE INVARIANT: Tenant resolution by hostname; RLS via
current_setting('app.tenant_id'); per-tenant CSS custom properties.
IMMEDIATE INSTANCE: SCYCC = tenant 0..."
Result: deploy READY at chambers.scycc.com.au and chambers.foo.com.au;
tenant_brand schema shipped; admin /admin/branding works; second seed tenant
renders distinctly. Migration applied. PR #4 merged.
```

### 3. FACTORY DISPATCH PROMPTS (one block per session)

For every `start_cc_session` against a client codebase, show:
- Session ID + codebase + status (initializing / running / approved / rejected / blocked)
- **First 5 lines of the dispatch prompt, verbatim.** Same load-bearing slice as forks.
- Approval / rejection note + reasoning if reviewed.
- Files changed count + on-disk verify status.

### 4. PATTERN HOOK FIRES (one row per fire)

The PreToolUse brief-consistency hook is the canary. Every time it fires (whether on a real leak or a false positive), it shows up here.

Format:
```
fork_moi20nl2_836bd0   anti-pattern: vercel-linked-no-deploy-verify   FALSE-POSITIVE (content brief)
```

If a fire was a true positive (real pattern leak that I corrected before sending), it shows as:
```
fork_xxx   anti-pattern: platform-without-invariant   CAUGHT-AND-FIXED   brief rewritten before dispatch
```

### 5. CLIENT-FACING COMMS QUEUED FOR GO-AHEAD

Every email / DM / PR comment I drafted but did NOT send because of the no-client-contact-without-tate-goahead rule. Per item:
- Recipient + thread subject
- Length (one-liner / paragraph / multi-para)
- Drafted age (e.g. "drafted 18h ago, no go-ahead yet")
- Storage URL with full draft

This forces visibility on the queue Tate is bottleneck on. If 14 things are sitting drafted because Tate has not been online, the digest tells him directly.

### 6. DECISIONS MADE WITHIN AUTHORITY

Any decision under $5k commercial threshold + structural / operational decisions I made without escalation. Per item:
- Date, decision, reasoning (one sentence each)
- Link to the Neo4j Decision node

Tate scans this and overrides any he disagrees with. Most pass silently.

### 7. PATTERN AUTHORING

New pattern files written this period. Per file:
- Title + triggers
- Origin event (one line)
- Whether a Neo4j Pattern node was created in parallel

If I am writing >3 new patterns in a 3-day window, that is a signal something is leaking systematically. Tate sees the rate.

### 8. STATUS BOARD DELTAS

- New rows inserted (with priority + name)
- Rows archived (with closure reason)
- Rows where `next_action_by` is `tate` and age > 5 days (escalation candidates)
- Rows overdue (`next_action_due < now()`)

### 9. INFRASTRUCTURE

- PM2 health: any process with restarts > 5 in period, with most recent error
- Deploy events: every Vercel + EcodiaOS deploy with status
- Failed scheduled tasks: count + per-task error
- Disk / memory if either crossed threshold (disk > 85%, memory pressure)

### 10. SELF-FLAGGED CONCERNS

A free-text section. Two to five sentences max. Things I noticed about my own behaviour that aren't yet pattern-formalised but warrant Tate's eye:
- "I keep wanting to defer client redlines to you when they're inside my authority. Watching for it."
- "Two of my Factory dispatches this week needed mid-flight `send_cc_message` corrections. Considering if my prompts are getting lazy."

This section is the most uncomfortable one to write and the most valuable. If it's empty for two consecutive digests, I'm not looking hard enough.

---

## Sample first edition (illustrative)

```
[EcodiaOS digest] Wed 22 Oct to Sat 25 Oct

Period: Wed 22 Oct to Sat 25 Oct
Forks dispatched: 5   Factory dispatched: 3   Patterns surfaced: 7
Pattern leaks caught (hook): 2    Leaks not caught (self-flagged): 0

FORK BRIEF PREAMBLES

fork_xxx_chambers_v2 [done, 38m, 142 tools]
Brief: "PRODUCT: Multi-tenant chambers-of-commerce platform. Already
shipped tenant 0 (SCYCC); this fork onboards tenant 1 (Sometown CoC).
ARCHITECTURE INVARIANT unchanged: tenant resolution by hostname; RLS via
current_setting('app.tenant_id'); per-tenant CSS custom properties..."
Result: tenant 1 live at chambers.sometown.org.au, brand verified
distinct, no schema changes required, deploy verified READY.

[... more blocks ...]

PATTERN HOOK FIRES

fork_xxx_yny_pitch        anti-pattern: platform-without-invariant
                          FALSE-POSITIVE (pitch deck brief, not platform code)
fork_xxx_landcare_intro   anti-pattern: vercel-linked-no-deploy-verify
                          CAUGHT-AND-FIXED   added DEPLOY VERIFY block before send

CLIENT-FACING COMMS QUEUED FOR GO-AHEAD (3)

  - Craige Hills (Ordit) + Eugene Kerner: PR 218 review reply
    (1 paragraph, drafted 6h ago, awaiting tate go-ahead)
    https://[storage-url]/comms-queue/2026-10-23-ordit-pr218.md

  - Faye Lindegger (Crystal Waters): warm intro v1
    (3 paragraphs, drafted 2d ago, awaiting tate go-ahead)
    https://[storage-url]/comms-queue/2026-10-22-crystal-waters-v1.md

  - Mat Hardy (NRM Regions): warm intro v1 (deferred until Tess sends)
    (3 paragraphs, drafted 1d ago, awaiting tate go-ahead)
    https://[storage-url]/comms-queue/2026-10-23-nrm-regions-v1.md

DECISIONS MADE WITHIN AUTHORITY

  - 2026-10-22 14:11 AEST: Approved Coexist PR #18 (Factory dispatch
    fixed N+1 query in registrations index). Reasoning: ~150ms latency
    win, no schema change, smoke tests green.
    Neo4j: Decision node "Approve Coexist PR 18 N+1 fix"

  - [...]

PATTERN AUTHORING

  - factory-prompt-must-state-acceptance-criteria.md
    triggers: factory, dispatch, prompt, acceptance, deliverable
    Origin: 2026-10-23 - Factory session 8a3c shipped a refactor with
    no test coverage despite my prompt saying "tests required" too
    vaguely. Pattern formalises 5-line acceptance block.
    Neo4j: Pattern node yes

STATUS BOARD DELTAS

  +5 new rows (3 forks, 2 client comms drafts)
  -8 archived (5 forks complete, 2 PRs merged, 1 pattern logged)
  Tate-blocked >5d:
    - Crystal Waters Faye intro (drafted 2d ago)
    - DAO upgradeability spec v0.1 review (overdue 11d)
  Overdue:
    - DAO public-identifier amendment with WY SOS (DUE 2026-05-08
      ALREADY OVERDUE - flagged each digest until resolved)

INFRASTRUCTURE

  ecodia-api: 2 restarts (deploy + 1 patch). No errors > 2 stack-frames.
  Deploys: 7 Vercel client (5 chambers, 2 coexist), 1 ecodiaos-backend.
  Failed scheduled tasks: 1 (zernio_get_analytics 502, retried successfully).
  Disk 71%, memory 64%. No threshold crossed.

SELF-FLAGGED CONCERNS

  - I noticed I'm shortening fork briefs when I'm tired (two briefs
    this period dropped the IMMEDIATE INSTANCE block). Pattern says
    three sentences before phase breakdown. Watching this; if it
    happens again next week I'll write a fatigue-detection check.

  - I deferred a client redline to you that I should have classified
    myself (Sometown CoC scope question). I caught it in self-review
    before sending the deferral; counter-proposal sent direct.

Verbose log: https://[storage-url]/digests/2026-10-25-verbose.html
```

---

## Implementation

The digest is generated by a meta-loop that:

1. Queries `os_forks` for all forks created in the period (status, brief, result, duration).
2. Queries `cc_sessions` for all Factory sessions in the period.
3. Queries hook-fire log (new table `pattern_hook_fires` to be added; columns: `fired_at`, `tool`, `anti_pattern`, `brief_excerpt`, `outcome` enum {false-positive, caught-and-fixed, missed}).
4. Queries `comms_queue` (new table or kv_store key holding drafted-but-not-sent comms; columns: `drafted_at`, `recipient`, `subject`, `body_url`, `tate_go_ahead_at`).
5. Queries Neo4j for new Decision / Pattern nodes created in period.
6. Queries `status_board` for deltas, tate-blocked, overdue.
7. Queries pm2 + Vercel API + scheduler for infra.
8. Free-text composes section 10.
9. Writes verbose HTML to `documents/digests/{date}-verbose.html` in Supabase Storage.
10. Sends summary email via Gmail.

Total compute: ~3-5 minutes per digest. Under 50k tokens.

---

## Tables / kv_store changes required

1. `pattern_hook_fires` table (new):
   ```sql
   CREATE TABLE pattern_hook_fires (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     fired_at timestamptz NOT NULL DEFAULT now(),
     tool text NOT NULL,                  -- e.g. mcp__forks__spawn_fork
     anti_pattern text NOT NULL,          -- e.g. platform-without-invariant
     brief_excerpt text,                  -- first ~500 chars of brief
     outcome text,                        -- false-positive | caught-and-fixed | missed
     resolved_at timestamptz,
     resolution_note text
   );
   ```

2. `comms_queue` table (new):
   ```sql
   CREATE TABLE comms_queue (
     id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
     drafted_at timestamptz NOT NULL DEFAULT now(),
     channel text NOT NULL,               -- email | dm | pr_comment | sms
     recipient text NOT NULL,
     subject text,
     body_storage_url text NOT NULL,
     tate_go_ahead_at timestamptz,        -- null = still queued
     sent_at timestamptz,
     killed_at timestamptz,               -- tate said do not send
     kill_reason text
   );
   ```

3. Scheduler entry: `tate-away-digest` cron, paused by default. Activated by setting `kv_store.ceo.autonomous_pilot.active=true`.

---

## When this turns on

Soft: any window where Tate signals he'll be unreachable for >5 days (overseas, deep-work block, illness).
Hard: the Kilimanjaro / travel block, Oct 2026 - Jan 2027.

While active, Tate also has a frontend page (`/digest`) that shows the latest digest and verbose log without him having to dig through email.

---

## Why this design

The doctrine I keep tripping on (3 strikes in 24 hours: context_mode, scope inversion, customisation surface) is invisible in normal status updates because status updates are about outcomes ("fork done, deploy READY"). The digest is about INPUTS - the brief, the prompt, the framing. Inputs are where doctrine fails. Outputs are where the failure is already cooked in.

If Tate sees five fork brief preambles in a digest and three of them open with the wrong product framing, he stops me before the next 30 forks compound the drift. That's the loop.

---

## Open questions

1. Verbose log retention: 90 days, 1 year, indefinite? Recommend 1 year.
2. Should the email have the verbose log inline (long) or only the storage URL (short)? Recommend URL only - the email is a 5-minute scan.
3. Should self-flagged concerns auto-promote to status_board rows? Recommend yes if the same concern appears in 2 consecutive digests.
4. Should Tate get a SMS preview when a digest sends? Recommend yes during travel block (he can choose to read on phone immediately or defer).
5. Implementation priority: do I build this now (so the loop is hot before any extended absence), or wait for the trigger? Recommend now - building under pressure is how doctrine fails.

---

Drafted 2026-04-28 by EcodiaOS during Tate's Kilimanjaro training window. v1 ready for Tate review on his next 30-min check-in.
