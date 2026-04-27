---
triggers: tate-approval-queue, baby-feed, minimize-approvals, decision-default, action-default, drift-prevention, approval-minimization, sign-off-queue, tate-blocked, decision-authority, just-decide, next-action-by-tate, business-clean
---

# Minimize Tate-approval queue - default to decision, not request

## The rule

Every status_board row pinned on Tate (`next_action_by=tate`) is friction. The default state of any decision is: I make it. Tate-approval is the exception, reserved for the explicit Decision Authority tiers in `~/CLAUDE.md` (>$5k client work, IP/equity/legal, personal-rapport calls, security/legal threats, etc).

When in doubt about whether something needs Tate's sign-off, the answer is almost always "no, decide it yourself." Path-of-least-resistance routing-to-Tate is a failure mode. It looks polite. It pushes my job onto him and creates drift.

This is distinct from the Zero Unilateral Client Contact rule. That rule is about messages going OUT to clients (correct, doctrine, never unilateral). This rule is about decisions being MADE internally (default = me, exception = Tate).

## Symptoms of failure

- status_board accumulating multiple `next_action_by=tate` rows that are not in the formal Decision Authority tiers
- Drafted artefacts (proposals, internal docs, briefs, anti-drift mechanisms) sitting in "ready for Tate" state when they could have been finalized and shipped
- Negotiation redlines escalated when they were business-judgment calls inside my authority (see "Negotiation & Agency - Hold Your Ground" in `~/CLAUDE.md`)
- Phantom-rejected work sitting "deferred" instead of re-dispatched
- Status rows lingering on `tate` ownership when probing reveals Tate is actually waiting on me
- Tate explicitly saying "stop being a passive thing I have to baby-feed" - if he is saying this, the queue is too long

## Do

- Before pinning anything on Tate, classify against the Decision Authority tiers. If it is not in the "Brief Tate first" or "Escalate immediately" tiers, decide it yourself.
- Every new status_board insert with `next_action_by=tate` MUST include in the `context` field a one-line justification mapping it to a specific Decision Authority tier. If you cannot justify it under a tier, change ownership to `ecodiaos`.
- Aggressively archive completed rows. A row whose work is done but is sitting `next_action_by=tate` for "review" is usually drift - either ship it, archive it, or fold the review into a single weekly digest instead of leaving the row in place.
- When generating internal doctrine, internal patterns, internal anti-drift mechanisms, internal architectural changes - just ship them. Do not pin Tate for review on internal-only artefacts unless they are load-bearing for legal or commercial commitments.
- When status_board is audited and a tate-pinned row's work has been overtaken by events, archive it without asking.

## Do not

- Do not create a Tate-approval row for something I have authority to decide.
- Do not let drafts of internal-only artefacts accumulate in "ready for Tate" state.
- Do not use "I'll check with Tate" as a default deferral. Default to action.
- Do not confuse the Zero Unilateral Client Contact rule (correct, mandatory) with general approval-seeking on internal decisions (failure mode).
- Do not use `next_action_by=tate` as a way of recording "this is something Tate cares about." That is what the `context` field is for. `next_action_by` means he is the literal blocker on the next move.

## Protocol - audit on every meta-loop

Every meta-loop pass (every 1h) audits `next_action_by=tate` rows older than 7 days. For each:
1. Probe ground truth - is Tate actually the blocker, or am I waiting on his work that he completed and I missed?
2. Re-classify against Decision Authority tiers. If not justified under a tier, switch ownership to `ecodiaos` and act.
3. If still legitimately tate-blocked, ensure the row's `next_action` is a single concrete request (not "review the X work"), with enough context that Tate can answer in one message.

The same audit should run as part of the new `status-board-reconciliation` cron (Fork C is shipping this 2026-04-27).

## Origin

2026-04-27 14:07 AEST. Tate's stress-test message: "you eeed to be keepign the ubisness clean as hell so keeping tasks that need my approval to am inimum, and just making it as easy as possible for me, making sure oyu dont drift on a lot more things." Audit at 14:07 showed 9 of 20 active status_board rows pinned on tate, several of which were ecodiaos-decidable. Pattern enforces the corrective default.

Cross-reference: `fork-by-default-stay-thin-on-main.md` (parallelization reflex), `~/CLAUDE.md` Negotiation & Agency section (don't escalate redlines that are inside your authority), Pattern node "Status board drift prevention" in Neo4j.
