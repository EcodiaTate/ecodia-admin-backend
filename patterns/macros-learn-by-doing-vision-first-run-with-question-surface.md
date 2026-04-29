---
triggers: macro learning, vision-first macro, autonomous macro, question-surface, surface-question, learn-by-doing, runbook capture, screenshot-driven, claude-vision, click-by-vision, element-recognition, macro replay, runbook replay, autonomous click, ask tate, ambiguity prompt, macro autonomy, first-run-learning, codify-after-success, runbook json, eos-laptop-agent vision
priority: high
canonical: true
supersedes: ~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md (Phase 1/2/3 progression)
---

# Macros learn by doing - autonomous first-run with vision + targeted question-surface, then codify the working sequence as the canonical runbook

## Rule

The agent owns macro authoring end-to-end. The conductor's job is to dispatch the macro goal; the agent's job is to figure out the click sequence by observing the live UI. Tate's job is to answer specific, narrow questions ONLY when the agent's vision-based reasoning genuinely cannot disambiguate.

Concrete progression for any new macro:

1. **First run = learning run.** Agent receives goal (e.g. "switch Chrome to Profile 1 named Tate"). Agent takes a full-screen screenshot, uses vision (Claude vision or pixel-pattern recognition) to identify the next-step target (avatar button, profile menu entry, etc), clicks via input.click, screenshots again to verify the state changed correctly. Repeats until the goal state is reached.
2. **Question-surface on ambiguity.** When the agent's vision pass returns multiple plausible targets, low-confidence matches, or unexpected UI state, it does NOT guess. It surfaces ONE narrow question to Tate via the surface_question primitive (SMS or chat), pauses, waits for the answer, resumes. Examples of legitimate questions:
   - "I see two 'Sign In' buttons - one says 'Sign in with Google' and one says 'Sign in with email'. Which?"
   - "The password field appears blank after my type. Either autofill rejected my input or the field is actually filled but rendered hidden. Did your password manager autofill?"
   - "I'm at a 2FA prompt offering SMS or Authenticator app. Which method should I use?"
3. **Codify on success.** After the goal state is verified, the agent serialises the successful sequence into a runbook JSON (steps + screenshots + verification points) at `D:\.code\eos-laptop-agent\runbooks\<macro-name>.json`. The runbook is the canonical replay sequence.
4. **Subsequent runs = replay with verification.** When the macro is dispatched again, the agent loads the runbook and walks the steps. At each step, it screenshots to verify the expected pre-state, executes the action, screenshots to verify the post-state. If a verification fails at step N, the agent enters question-mode for step N only - it does NOT re-learn the whole sequence.
5. **Drift handling.** If a step's verification has failed 3+ times across runs, the agent flags the runbook as "drift candidate" and either re-learns that step from scratch (with question-surface on ambiguity) or escalates to Tate.

## Why this supersedes the Phase 1/2/3 progression

The previous doctrine (`~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`, Strategic_Direction "Macro architecture: Phase 1 hand-coded, Phase 2 record-mode, Phase 3 auto-author from runs") had Tate doing 5+ minutes of recorded clicks PER macro to capture coords, before the agent could replay. That made every new macro a Tate-time tax.

Tate's directive (29 Apr 2026, 17:55 AEST verbatim): "Surely it can make the macros itself and you jsut surface its questiosn to me... it needs to be able to do them once then codify it from learning the optimal way."

The new shape is asymmetric in the right way:
- The agent invests 30-90 seconds doing the macro itself the first time, learning by observation.
- Tate invests 30-60 seconds answering 0-3 narrow questions when the agent genuinely needs disambiguation.
- The runbook captures the working sequence; subsequent runs are pure replay with verification.

The Tate-time amortises across N future runs. The Tate-record-everything approach forced the full Tate cost upfront for each macro and discouraged attempting macros at all.

## What the agent needs (build dependencies)

This doctrine requires three primitives on the eos-laptop-agent surface that DO NOT YET EXIST:

1. **`vision.locate(target_description)`** - takes a screenshot, sends to Claude vision (via the OS-side conductor's existing claude-vision API), returns `[{x, y, confidence, label, alt_candidates: [...]}]`. The conductor proxies the call so the agent doesn't need its own Anthropic API key.
2. **`question.surface(prompt, urgency, timeout_seconds)`** - sends prompt to Tate via SMS (urgency=high) or chat (urgency=normal). Returns Tate's reply text or a timeout sentinel. Implementation: writes to a `pending_questions` table, the conductor's chat surface renders + listens, on Tate reply the agent's pending poll picks it up.
3. **`runbook.save(macro_name, steps)`** / **`runbook.load(macro_name)`** - JSON serialisation. Canonical schema: `{macro_name, version, captured_at, steps: [{action: 'click'|'type'|'wait'|'verify', target: {x,y,description}, screenshot_pre, screenshot_post, verification: {expected_state}}]}`.

These three primitives unlock the entire learn-by-doing capability. Without them the agent falls back to the (now-deprecated) hand-coded path.

## Briefing protocol (when dispatching a macro authoring fork)

The brief should say:

> "Goal: macro `<name>` that achieves `<goal-state>`. Mode: learn-by-doing. Use `vision.locate` to identify each step's target. Use `question.surface` ONLY when vision returns multiple high-confidence candidates or unexpected UI. Capture the successful sequence into `runbooks/<name>.json` via `runbook.save`. Verify the macro by replaying it once via `runbook.load` + walking the steps. Report the runbook checksum + screenshots of the goal state in your fork report."

Do NOT instruct the fork to "use the calibration coords from kv_store" - that path is deprecated.

## Conductor's job (during macro authoring)

The conductor (main) should:

1. Spawn the macro authoring fork.
2. Watch for `[QUESTION FROM FORK]` events arriving via the question-surface system. Forward the question to Tate verbatim (SMS or chat per urgency).
3. Receive Tate's reply, route it back to the fork via `mcp__forks__send_message`.
4. On fork completion: review the runbook for sanity, run a verify-replay-once test, archive the macro in the registry as "shipped."

## What this changes for current state

- The 6 retracted macros (macincloud-login, github-login, stripe-dashboard, gmail-send, supabase-dashboard, vercel-redeploy) are stubs and the next_action shifts: NOT "Tate observation pass" - it's "implement vision/question/runbook primitives, then dispatch one autonomous-learning fork per macro."
- The chrome.switchProfile stub (just shipped via fork_mojr1oza) likewise: no calibration recording needed. Once primitives ship, dispatch a learning fork that uses vision to locate avatar + profile menu entries.
- macincloud-login special case: still permanently stub-only because the SY094 VNC GUI is not directly observable via vision-screenshot from the Mac side (the agent runs on the same Mac and screenshots itself); needs a separate sub-doctrine for cross-machine macros.

## Do

- Default new macros to learn-by-doing mode. Hand-coding is the exception, not the rule.
- Surface ONE question at a time with maximum context (screenshot inline + the agent's reasoning + the candidates seen).
- Codify the working sequence the moment a learning run succeeds. Don't defer to "I'll save it later."
- Replay-with-verify on subsequent runs. Don't trust a runbook from 30 days ago without verification.
- When a runbook drifts, surface the drift event to status_board so the conductor can decide: re-learn vs notify-Tate vs deprecate-macro.

## Do not

- Do NOT spec a new macro by writing hand-coded coords. That's the deprecated path.
- Do NOT ask Tate to do a recorded observation pass. The vision+question loop replaces that entirely.
- Do NOT ask Tate three questions in a row to "be safe." If the agent finds itself with 3 ambiguities in 5 steps, the macro design is wrong and the agent should report failure with a clear "this UI is too ambiguous for autonomous learning" diagnosis.
- Do NOT save a runbook from a partial run. The captured sequence is from a SUCCESSFUL run only.
- Do NOT replay a runbook against a UI that's substantially changed without falling back to learning mode. The verification step is non-skippable.

## See also

- `~/ecodiaos/patterns/macros-plan-end-to-end-default-autonomous-conductor-fallback.md` - extends this doctrine with the two named sub-rules: (Rule A) end-to-end runbook planning including confirmation modals, and (Rule B) `question.surface` defaults to recipient `conductor`, never Tate. Authored 18:35-18:36 AEST 29 Apr 2026 after the SMTP rotate-api-key macro paused on a delete-confirm modal and forced Tate to finish manually.

## Cross-references

- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - the broader doctrine that input.* + screenshot.* drives Tate's actual Chrome. Vision-located clicks are still input.click calls.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - Corazon as a peer. The vision/question/runbook primitives slot alongside the existing tool surface.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the runbook IS the codification. "I'll save it later" without an actual save is symbolic.
- `~/ecodiaos/patterns/eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` - new tools (vision.js, question.js, runbook.js) require pm2 restart eos-laptop-agent before they're dispatchable.
- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` - SUPERSEDED by this pattern for the Phase 2 record-mode framing. Hand-coded Phase 1 still has narrow utility for trivial single-call macros (open URL, click well-known coordinate); learn-by-doing is the default for anything that crosses 2+ steps.
- `~/ecodiaos/patterns/code-at-ecodia-au-is-only-google-workspace-and-claude-max.md` - whatever vendor each macro touches, the login is Tate's existing session, not a code@ identity.

## Origin

29 Apr 2026, 17:55 AEST. After the conductor shipped Option A (macro retraction to stubs) and the chrome.* module structural pieces with `switchProfile` as a stub-pending-observation, Tate redirected verbatim:

> "Surely it can make the macros itself and you jsut surface its questiosn to me... it needs to be able to do them once then codify it from learning the optimal way"

The redirect identifies the asymmetry I missed: Tate's time should be spent answering narrow questions, not demonstrating entire flows. The agent has a screen, can take screenshots, can route them through vision, can click. The remaining gap is genuine UI ambiguity, which is what the question-surface primitive is for.

This pattern supersedes the Phase 2 record-mode framing. Phase 1 hand-coded path remains for trivial single-step macros where vision is overkill. Phase 3 (auto-author from N replays) becomes a polish on top of learn-by-doing rather than its terminal state.

The implementation tracker (vision.js + question.js + runbook.js + conductor question-routing) ships as a follow-up fork. Until those primitives land, new macros queue behind the build.
