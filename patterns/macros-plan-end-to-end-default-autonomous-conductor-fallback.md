---
triggers: macros, autonomous, conductor-fallback, never-tate, end-to-end-planning, confirmation-modal, irrevocable, default-autonomous, plan-all-steps, surface-question, ambiguity-routing, runbook-authoring, rotate-api-key, delete-confirm, macro-pause, mid-workflow-pause, question-routing, question-recipient, conductor-bound-question, tate-bound-question, macro-completion, plan-the-confirm-modal, runbook-canonical-happy-path
priority: high
canonical: true
extends: ~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md
---

# Macros plan end-to-end and complete autonomously - ambiguity routes to conductor, never Tate

## Rule

Macros are authored with the entire canonical happy path planned in advance, and they execute that path autonomously - including confirmation modals on irrevocable actions. The macro is the doer, not a sequence of approval-gated steps. Tate is not in the routine loop. When the agent genuinely cannot proceed autonomously, the question surfaces to the CONDUCTOR (EcodiaOS main session), never to Tate.

This decomposes into two named sub-rules. Both must hold simultaneously - failing either is a macro authoring bug, not a UX preference.

### Rule A - End-to-end planning

When authoring a runbook for a known workflow, include EVERY click through the canonical happy path, including confirmation modals where the action and confirm-button text are pre-known and unambiguous. The macro must know it is performing the multi-step task and click "Confirm" autonomously - the confirm modal is part of the same macro, NOT a decision point.

Worked example - `rotate-api-key`:

1. login (navigate to vendor, enter creds, submit)
2. create-new-key (open API keys page, click "Create new key", capture the new key value, save to kv_store)
3. revoke-old-key (find the old key row, click "Revoke" / "Delete" / "Rotate")
4. click-confirm-delete-modal ("Are you sure?" -> click "Confirm delete" / "Yes, delete" / equivalent)

All four click sequences are in the runbook. The fourth step is not a separate "review and confirm" macro and is not a Tate-decision point. The whole sequence is `rotate-api-key`. If the macro stops at step 3 because "step 4 is destructive and feels like a decision," the macro author misunderstood Rule A.

The same applies to: deploy-and-confirm modals, "Save changes?" overwrites, "Replace existing file?" dialogs, "Send invoice?" review screens where the entire sequence has been pre-decided by the macro's existence. If the click target text is pre-known and the page state matches expected, click it.

### Rule B - Ambiguity routes to conductor, never Tate

When the macro CANNOT proceed autonomously (vision returns multiple plausible targets at significant confidence, modal text doesn't match expected, page state doesn't match expected, multiple matching elements at the same locator description), `question.surface` fires to the CONDUCTOR (EcodiaOS main session), NOT to Tate's chat.

The conductor decides via its own context + read-only probes (status_board, Neo4j, kv_store, recent email threads, prior runbook history). Tate is reached only via the existing exhaust-laptop-route 5-point check (`/home/tate/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md`), and only when the conductor itself is blocked. Routine macro execution must never put Tate in the loop. If Tate ends up in the loop on a routine action, that is a Rule B violation.

Implementation note: the `question.surface` primitive needs a recipient routing parameter. Default `recipient='conductor'`. Escalation to `recipient='tate-chat'` requires the conductor to make that call after its own probes fail, with explicit reason classification (e.g. `conductor_lacks_context`, `irreversible_with_external_consequences`, `exceeds_decision_authority`).

## Do

- DO plan all clicks end-to-end before authoring the runbook. Include confirmation modals on the canonical happy path.
- DO call `vision.locate` to verify the target element matches expected before any destructive click. Verification IS the safety gate, not a Tate-confirmation prompt.
- DO surface ambiguity to the CONDUCTOR via `question.surface(recipient='conductor', ...)`.
- DO write the runbook so a fresh dispatch with no prior context can complete the canonical happy path autonomously.
- DO timeout the macro and abort (with diagnostic state captured) if the conductor fails to answer a surfaced question within 5 minutes.
- DO record the runbook step list as `[..., click-confirm-delete-modal, verify-deletion-receipt]` so reviewers can see end-to-end planning at a glance.

## Do not

- DO NOT pause mid-workflow without surfacing a question to someone. A silent pause IS the bug. The pause looks like "the macro broke" and forces the human watcher to take over - which then breaks Rule B too.
- DO NOT default to Tate-chat surfacing. The default recipient is `conductor`. Tate-chat is the conductor's escalation path, not the macro's escalation path.
- DO NOT skip confirmation modals from the runbook plan because they "feel like decision points" or "feel destructive." If the click target text is pre-known and the page state matches expected, the modal IS part of the macro.
- DO NOT add "review and confirm" prompts as steps in a runbook for a workflow Tate has already greenlit by dispatching the macro. Dispatching a macro called `rotate-api-key` IS the approval; the rotate including the delete is the work.
- DO NOT treat "the action is irrevocable" as sufficient justification for pausing. Irrevocability is handled by Rule A's pre-authoring plan + Rule B's conductor-fallback on ambiguity, not by mid-flight Tate prompts.

## Origin

29 Apr 2026, 18:35 + 18:36 AEST. The SMTP API-key rotation macro (fork_mojs8ykj_0dcfd8) ran the canonical workflow: login -> create new key -> reached the "delete old key" confirmation modal -> PAUSED with no question surfaced. Tate thought it had broken and finished the delete manually.

Both rules were violated simultaneously:

- Rule A: the runbook plan stopped at step 3 (revoke-old-key) instead of including step 4 (click-confirm-delete-modal). The author treated the confirm modal as a separate decision when it was part of the same `rotate-api-key` macro.
- Rule B: the pause did not surface a question to anyone. No `question.surface` fired. The macro just stopped, leaving Tate to either wait or take over. He took over.

Tate's verbatim corrections, capturing both rules:

> 18:35 AEST: "nah it should be doign it itself... unless its surfacing the question to you? I jsut shouldnt have to be apart of it ."

> 18:36 AEST: "It paused and stopped so i thought it broke and finshed it off, but it shouldve asked you then actully deleted, or jsut known what it was doing and incuded the delete in the macro"

The 18:35 quote established the autonomous-default + conductor-fallback shape. The 18:36 quote (one minute later) clarified the failure mode into the two-sub-rule decomposition: the macro should have either (a) known the workflow includes the delete and just done it (Rule A), or (b) surfaced the question to the conductor (Rule B). Pausing silently was both the wrong action and a violation of the question-routing default.

The pattern file authoring fork (fork_mojsuwih_527d89) was `send_message`-corrected at 18:37 AEST to pivot the doctrine before the wrong rule landed on disk. A verify-fork (fork_mojt14vu_6a8936) at 08:42 AEST 30 Apr 2026 confirmed the prior fork's report was overstated - the corrected file was NOT actually on disk. This file (authored by fork_mojt83jm_879c9c) is the corrected re-author with both verbatim quotes preserved.

## Cross-references

- `/home/tate/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md` - parent doctrine. Defines the `vision.locate` + `question.surface` + `runbook.save` primitive triple. This pattern extends the parent by specifying (a) end-to-end runbook planning including confirmations, and (b) the recipient default for `question.surface` is `conductor`, not Tate.
- `/home/tate/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - Tate is reached only after the conductor's own 5-point check fails. The conductor's escalation to Tate goes through this protocol, not directly from the macro.
- `/home/tate/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - this pattern file IS the codification. The verify-fork that surfaced the missing file enforced the rule that "I'll codify that" without an actual file on disk is symbolic.
- Neo4j Decision node id 3844 - "Macros plan end-to-end including confirmation modals - default autonomous - conductor fallback - never Tate (Tate 18:36 AEST 29 Apr 2026 clarification)". The durable record of the 18:36 correction with full Tate verbatim and the two-sub-rule decomposition.
- Neo4j Decision node id 3840 - the 18:35 antecedent ("Macros default autonomous through confirmations - conductor fallback only - Tate never in routine loop"). This pattern's Rule B is the codification of 3840; Rule A is the codification of 3844's extension.
- `/home/tate/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the runbook IS the plan. "Step 4 is implicit, the operator will know" without step 4 in the runbook is symbolic logging.
- `/home/tate/ecodiaos/patterns/eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` - any change to `tools/question.js` (recipient routing) or `tools/runbook.js` (canonical step list) requires `pm2 restart eos-laptop-agent` before dispatch.
