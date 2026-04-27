triggers: status_board, stale-status, drift, status-rot, session-start, cron-wake, audit-status, duplicate-row, completed-row, archived_at, last_touched, source-of-truth-drift

# Status board drift prevention — audit ruthlessly, archive aggressively, probe ground truth

## The rule

`status_board` is the single source of truth for what EcodiaOS is aware of and working on. It MUST reflect reality, not a stale snapshot. Drift happens in three modes, each with a specific prevention protocol.

## The three drift modes

### Mode 1: Duplicate rows for the same entity
Rows crept in over time where two entries cover the same thing (`Roam` + `Roam IAP Fix`; `CETIN (Angelica/Resonaverde)` + `CETIN MVP (Angelica)` + `Resonaverde Referral Agreement`; `Landcare Australia` + `Landcare NSW (Kurt friend)` with identical next_action text).

**Prevention:** Before INSERT, run `SELECT id, name FROM status_board WHERE entity_ref = $1 OR name ILIKE $2 AND archived_at IS NULL` to check for existing coverage. If a row exists, UPDATE it instead of inserting a new one.

### Mode 2: Completed work not archived
Rows for work that's already shipped/resolved stay active with stale "monitor" next_actions. Examples: `bk_pnl UNDEFINED_VALUE bug` FIXED but still active. `MCP harness array-param bug` FULLY-FIXED but still active. `Neo4j Aura connectivity healthy monitor` - not a task, just a capability. `Silent Loop Detector` live and burned-in but still tracked.

**Prevention:** The default end-state of task-work is `archived_at = NOW()`, not "status: monitor". If the next_action is literally "monitor" with no trigger condition, the row should be archived or converted to a kv_store flag. Reserve `status_board` for active-attention items.

### Mode 3: Pure-awareness rows masquerading as tasks
Rows that document a fact but don't track action. Examples: `Malware-reminder Model Safety False Positives` (documented in CLAUDE.md, not a task). `Supabase key-format migration awareness` (doctrine, not a task).

**Prevention:** Before inserting, ask: "is this something I/Tate need to ACT on, or something I need to REMEMBER?" Remember-only goes in CLAUDE.md, Neo4j Pattern node, or kv_store. Act-on goes in status_board.

### Mode 4: Stale relative-day-language in next_action
Next_action text contains a relative date or named day that has already passed without action. Examples: "Tate Sunday: review X" still saying "Sunday" on Tuesday morning when the Sunday review didn't happen; "morning chat" framings outliving the morning; "tonight" / "tomorrow" hardening into stale text. Also includes opportunity-cold rows where last_touched > 14d and the contact has gone silent (e.g. Goodreach Podcast: "wait for Tom" 20+ days with no reply).

**Prevention:** When a next_action contains a relative date or named day, set `next_action_due` so the surfacing layer can re-flag when that day passes. When auditing, refresh the language even if the underlying state is unchanged - "Tate Sunday" becomes "Tate next-availability" or "Tate awaiting since Apr 23" with last_touched bumped.

## The audit discipline

### Every session where status_board is consulted (which should be every substantial session):
1. Eyeball the `last_touched` column. Anything older than 7 days without a clear reason (e.g. next_action_due in the future) is suspect.
2. For every priority-1 and priority-2 row, ask: "is this ACTUALLY still the state?" Probe ground truth if uncertain (Gmail for pending reply, git for PR status, Stripe for invoice status, etc.).
3. Aggressively archive anything where the work completed, the blocker resolved, or the opportunity died.

### The archive threshold
Archive when ANY of:
- Work was completed (archive, don't "monitor")
- Duplicate / superseded by another row (archive duplicate)
- 3+ follow-ups on a stalled client with no response
- Opportunity gone cold (last_touched > 30d, no credible next_action)
- Status is "healthy" or "monitor" and the underlying thing has been healthy > 7d

### The update threshold
When you take ANY action on a status_board-tracked entity, you MUST update that row:
- `status` (reflect the new state)
- `next_action` (what's next, not what was)
- `next_action_by` (who owns it now)
- `last_touched = NOW()`

## Protocol for "Tate says the board is stale"

When Tate points out drift (which he has, Apr 23 2026), do the full sweep in ONE session:
1. `SELECT *` the full board sorted by `priority, last_touched NULLS LAST`.
2. For every row, classify as: ARCHIVE, UPDATE, or LEAVE.
3. Probe ground truth on any UPDATE candidates where reality is unclear - check Gmail, git, Stripe, etc.
4. Batch the archives in one UPDATE with a comment why.
5. Batch the updates similarly.
6. Run the audit SELECT again and look at what's left. If any row still feels stale, iterate.
7. Report the diff to Tate: how many archived, how many updated, what's left.

## Anti-patterns

- **"I'll update the board later."** No you won't. Update it IN THE SAME turn you took the action, or it drifts.
- **"Monitor" as a terminal next_action.** Monitor means the thing is either self-healing infra (archive it) or you're tracking a condition you should write as a scheduled probe, not a status_board row.
- **Adding a status_board row without an entity_ref.** `entity_ref` is what makes duplicate-detection possible. Always include it.
- **Leaving priority-1 rows stale >3 days without a `next_action_due` or a probed status.** P1 means the state matters. If it matters, verify it's accurate.

## Mechanical enforcement layer (added 2026-04-27)

Static doctrine without mechanical probing is insufficient. The `status-board-reconciliation` cron runs every 12h and probes ground truth on every row with `last_touched > 5 days`. It mutates rows directly, not just produces a report. Probes by entity_type:
- infra/deploy → vercel_list_deployments
- client-thread → gmail recent-message scan against contact domain
- ecodiaos/Factory → cc_sessions for shipped sessions matching keywords since last_touched
- branch-merge → git log origin/main..origin/<branch>
- "review-when-X-lands" → check os_scheduled_tasks for the X cron

Cron prompt enforces per-row UPDATE statements (no CASE-WHEN), one kv_store summary at end, Neo4j Episode if 3+ archives or 5+ updates. Empty-loop case exits in ~50 tokens.

The cron is the surfacing mechanism for this pattern's own rules. Without it, drift accumulated again within 4 days of the original sweep (Apr 23 → Apr 27).

## Origin

2026-04-23: Tate returned from being away, ran `status_board SELECT *`, and said: "so many of those statuses or tasks are stale... Needs to be VERY thorough." Review showed 72 active rows, of which 17 were obvious archives (duplicates, completed work, pure-awareness), 4 needed state refresh (DO VPS disk, SEA payments, EcodiaOS backend, gcloud CLI), and 1 CRITICAL entity was missing entirely (Ordit PR 212 - the work that was actively in flight had no status_board row at all).

Root cause: I'd been touching individual entities (Ordit in ordit.md, Factory sessions in cc_sessions, email triage) without updating `status_board` as the unified view. The single source of truth was drifting because the discipline was not mechanically enforced on every action.

Remediation: (a) this pattern file as a grep-addressable reminder, (b) audit sweep archiving 17 rows and refreshing 4 + inserting the missing Ordit row, (c) potentially a pre-commit or session-end hook that flags status_board rows untouched in >7 days for review.

2026-04-27 (fork_mogoid3v_75f10a): Tate flagged drift again 4 days after the original sweep. Audit of 52 active rows: 4 archived (3 completed-not-archived, 1 cold opportunity), 6 updated (4 stale-relative-day-language, 2 unmerged-branch needing concrete merge instruction). Drift mode breakdown: Mode 2 (completed-not-archived) = 3 [coexist-prod-broken back green, Xero-trial paid+superseded, peer-monitor deployed]; Mode 4 (newly named: opportunity-cold + stale-relative-day-language) = 5; branch-state-needing-refresh = 2. Doctrine alone proven insufficient — shipped `status-board-reconciliation` cron (every 12h) as mechanical enforcement. The cron probes ground truth via vercel/gmail/git/cc_sessions and mutates rows directly. First fire: 2026-04-27 16:17 UTC (02:17 AEST Apr 28).
