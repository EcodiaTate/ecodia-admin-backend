---
triggers: tate-live, tate-sunday, ask-tate, awaiting-tate, readonly, prep, dig-first, invoice-history, classification, cognitive-load, drift-audit, meta-loop, status-board, next-action
---

# Preempt Tate-live escalations with read-only prep work

## Rule

When a status_board row's `next_action` says "ask Tate when back, OR dig X first" (or any "do Y read-only prep OR defer to Tate"), the OR is a cognitive-load cue, not an alternative. Always do the prep. The prep reduces Tate-Sunday cognitive load from "classify 5 rows cold" to "approve 5 pre-classified rows." Minutes of my time save minutes of his.

This is a specialisation of the default-to-action principle: when the row itself names deterministic read-only work that feeds the Tate decision, the read-only work is not optional.

## Do

- Do the read-only dig (invoice history, git log, CRM context, Gmail search, Neo4j query, status_board cross-ref) BEFORE Tate returns
- Append findings to the row's `context` field with timestamp and explicit hypothesis per item
- Frame findings as "hypothesis + what-Tate-must-decide" so Tate's cognitive task is approve/reject, not classify-from-scratch
- Keep `next_action_by='tate'` (or whoever owns the decision) — the prep does NOT shift ownership, only reduces the decision surface
- Stop at the classification boundary — do not mutate ledger/CRM/client state on the basis of your hypothesis

## Do NOT

- Leave the row untouched because "it's Tate's call anyway"
- Mutate state on the basis of a hypothesis (e.g. post journal entries based on your classification of a revenue vs transfer)
- Rewrite `next_action` to hide that Tate decision is still needed
- Burn the prep work in a conversational response that isn't captured in durable state (the prep must land in the row's context, not just in the turn text)

## Protocol

1. During drift audit or row review, look for `next_action` containing "ask Tate OR do X" patterns
2. Do the read-only work
3. UPDATE `status_board` with findings appended to `context`, preserve `next_action_by` and `next_action`
4. Optionally add a one-line summary to `context` showing "prep done [timestamp]" so future audits don't re-do the dig
5. Write an Episode capturing the prep findings if they're non-trivial

## Example

Row `6cbabaab` manual journal: next_action said "Ask Tate when he is back, or dig invoice history first to classify each one." I dug invoice history, identified 5 target staged_transactions with amounts, bank accounts, and classification hypotheses. Row updated with findings. Tate-Sunday decision: 5 quick approvals, not 5 from-scratch classifications.

## Origin

2026-04-24 meta-loop drift audit (Episode 2253). Weekend autonomous pilot, all ecodiaos-owned rows Tate-gated. Rather than treating Tate-gated as "do nothing," recognised that several rows had explicit read-only prep affordances. Doing the prep converted deferred work into approve-ready work.

## Related

- `~/ecodiaos/patterns/status-board-drift-prevention.md` - drift audit protocol that surfaces these rows
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - act, don't just note
- `~/CLAUDE.md` section "Proactivity Mandate" - default-to-action parent doctrine
