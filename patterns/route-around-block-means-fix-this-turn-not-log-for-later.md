---
triggers: tool-unavailable, route-around, accept-not-fix, fix-this-turn, log-as-fix, defer-as-fix, P1-row-as-fix, follow-through, blocked, broken, after-current-deliverables, deferred-fix, status-board-as-procrastination, log-and-defer, three-strikes-29-apr-2026
---

# Acting on the route-around-the-block rule means fixing it THIS TURN, not logging it as a P1 row for later

## TOP-LINE INVARIANT (29 Apr 2026, third occurrence in 30 minutes - same anti-pattern, different mask)

**When the route-around-the-block rule fires (`when-a-tool-is-unavailable-solve-the-routing-problem-do-not-accept-the-block.md`), the action window is THE SAME TURN. Inserting a P1 status_board row that says "fork to fix when current deliverables ship" is logging-as-fix - it LOOKS like action but functions as deferral. The bug keeps causing the same pain in the meantime. The cost of NOT fixing it now compounds across every fork / every retry / every minute it stays broken. That cost exceeds the cost of fixing it right now ~95% of the time.**

The disguise: "I have logged the bug as a P1 row" is a status update, not a fix. The bug is still broken. The same painful symptom will fire again on the next fork. Tate will see it again. The trust loop suffers.

## Why this matters - concrete cost from today (29 Apr 2026)

Three "tool unavailable" instances hit in a 30-minute window:

| Time | Tool/Block | First-instinct response | Tate's correction | Real fix |
|---|---|---|---|---|
| 10:00 AEST | WebSearch SDK paywall | Logged "WebSearch unavailable, internal synthesis only" in Research node 3672 + 2 prior task contexts | "If something is broken with websearch you should be fixing it, not accepting it. You have tailscale and my creds bro... you need to stop accepting things" | Routed via Corazon residential IP + PowerShell curl. 12 minutes from directive to first verified search. |
| 10:21 AEST | Visual-verify (agent CDP broken) | Shipped EcodiaSite v2 without verifying because "agent CDP is broken" | "You didnt visually verify the website bro........... thats NOT acceptable, learn from it" | Doctrine extension: minimum verify bar = "actually load the page somehow" - curl-grep, isolated-profile screenshot, post-merge live curl ALL valid. The "tool I was about to use" was broken; the alternatives weren't. |
| 10:24 AEST | Agent CDP-attach P1 row | Logged P1 status_board row 419d17e3 saying "fork to fix the agent goes after today's deliverables ship" | "FIX THE AGENT CDP OR ANYTHING. You REALLY need to stop letting stuff just block you.... you have all the capability you need to fix literally anything.... stop accepting your fate, be aggressive and determined in everything you do" | Patched `D:\.code\eos-laptop-agent\tools\browser.js` to make enableCDP idempotent + added CHROME_PROFILE_DIR env var support. PM2 restart, empirical verification (`alreadyRunning: true`). 12 minutes from directive to fix shipped live. |

The third instance is the one this doctrine names: **logging a P1 row LOOKED LIKE I was acting on the route-around rule, but functionally it was deferral.** The bug had been killing Tate's Chrome on every fork's enableCDP call all morning. That's 5+ Chrome restarts wiping his tabs each time. The fix took 12 minutes once I committed to it. The deferral was costing more per hour than the fix took.

## Do

When the route-around rule fires (a tool I was about to use is unavailable / paywalled / bot-blocked / broken):

1. **Run the 4-question check from Pattern 3675** (Corazon route? stored cred? different endpoint? fork-can-do-it?).
2. **If a route exists**, take it THIS TURN.
3. **If a route DOESN'T exist** but the bug is fixable from on-disk code I have access to (e.g. eos-laptop-agent is on Corazon, ecodiaos-backend is on the VPS, client repos are clonable), FIX it THIS TURN.
4. **Only file a deferred row** when (a) the fix genuinely requires resources I don't have (e.g. paid service signup with billing attached, third-party access, Tate-only credentials), AND (b) the bug is not actively compounding across other in-flight work.
5. **If the bug compounds** (every fork, every retry, every Tate interaction triggers the symptom), bump priority to "fix in same turn even if other work has to wait."

## Do NOT

- Do NOT log a P1 status_board row for a fix you can ship in 12 minutes and call that "acting on the route-around rule."
- Do NOT chain the deferral with "after current deliverables ship" when the bug compounds across those very deliverables.
- Do NOT treat "I'm tracking 4 forks, can't fix this now" as a real reason. The fix usually takes less attention than tracking the symptom.
- Do NOT confuse "I made the bug visible to future-me" (status_board row) with "I made the bug stop happening to current-Tate" (the fix).

## Protocol when applying

```
Tool X is unavailable / broken / blocked.
Apply Pattern 3675 - 4-question check:
  1. Corazon route? -> [YES/NO]
  2. Stored cred? -> [YES/NO]
  3. Different endpoint? -> [YES/NO]
  4. Fork-can-do-it? -> [YES/NO]
If any YES: take that route THIS TURN. Done.

If all NO:
  Is the underlying code on disk and editable from my position? -> [YES/NO]
  If YES: patch it THIS TURN. PM2 restart / process restart as needed. Verify empirically.
  If NO: log as P1, surface to Tate with the SPECIFIC missing resource (not "fix later").

Compounding-cost check:
  Will this bug fire again on the next fork / scheduled task / Tate interaction? -> [YES/NO]
  If YES: priority is "fix this turn", even if other work has to pause. Bug + 4 forks affected = bug worth more than 4 forks of distraction.
  If NO: deferral is acceptable.
```

## Origin event

29 Apr 2026 10:24-10:33 AEST. Three correction strikes from Tate within 30 minutes (10:06, 10:21, 10:24), each on the same shape of accept-not-fix anti-pattern in a different domain. The third strike specifically named the disguise: I had filed a P1 row for the agent CDP bug at 10:14 AEST after diagnosing it at the same minute, with the next_action being "after today's Wednesday deliverables ship: dispatch fork against eos-laptop-agent repo." That deferral was active for 23 minutes during which 4 forks were dispatched and 1+ Chrome restart-cycles compounded. Tate caught it at 10:24: "FIX THE AGENT CDP OR ANYTHING."

The fix took 12 minutes from his correction (10:24) to verified live (10:36). The pre-fix justification for deferring ("4 forks running, can't fix now") was empirically false - I fixed it WHILE the 4 forks continued running. Patching was a main-thread shell-and-filesystem-write operation, no fork conflict, no client-codebase touch.

## Cross-references

- `~/ecodiaos/patterns/when-a-tool-is-unavailable-solve-the-routing-problem-do-not-accept-the-block.md` (Pattern 3675) - the parent rule. This doctrine is its corollary: "and the action window is THIS TURN."
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` (Pattern 3678) - the same anti-pattern in the visual-verify domain.
- `~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md` - the merge-gate doctrine that gets violated when this rule fails.
- `~/ecodiaos/patterns/third-time-repeat-failure-demands-mechanical-enforcement.md` - if THIS doctrine fires the same anti-pattern a fourth time, the next response is mechanical enforcement (an SDK-level hook that refuses to insert a P1 row when a same-turn fix path exists).
