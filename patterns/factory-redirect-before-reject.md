---
triggers: reject_factory_session, resume_cc_session, send_cc_message, factory-phantom-session, redirect-first, factory-redirect, factory-correction, in-flight-correction, factory-completed-wrong, factory-ladder
---

# Redirect Factory before reject - reject is the last rung, not the first

## The rule

When a Factory session has produced wrong, incomplete, or phantom output, do NOT call `reject_factory_session` as a first response. The correct ladder is:

1. **Mid-flight drift visible** (session still running, doing wrong thing) -> `send_cc_message(sessionId, "<correction>")` to redirect without aborting.
2. **Completed but wrong / phantom / incomplete** -> `resume_cc_session(sessionId, "<concrete deliverable list + on-disk evidence of what's missing>")` to continue with full context preserved.
3. **Reject ONLY** when:
   - The session has done genuinely destructive work that needs to be undone in a clean worktree, OR
   - The session has so fundamentally misunderstood the task that resume cannot recover (rare), OR
   - The session is unrecoverably stuck (e.g. hard error, killed process, corrupt state), OR
   - **`cc_sessions.cc_cli_session_id` is NULL** (precondition for resume). `factoryRunner.resumeSession()` invokes `claude --resume <cc_cli_session_id>` and silently no-ops if the CLI id was never persisted. Always verify before attempting resume:
     ```
     SELECT cc_cli_session_id FROM cc_sessions WHERE id = '<sessionId>';
     ```
     If NULL, the bridge will accept the publish but factoryRunner cannot reattach. Treat as unrecoverable for resume; reject and redispatch.

## Concurrency caveat - reject is destructive to OTHER running sessions on the same codebase

`reject_factory_session` performs a worktree clean on the codebase's working directory. If another Factory session is RUNNING concurrently on the same codebase, the reject will nuke its in-flight files. Always check `get_factory_status()` before rejecting:

- If activeSessions on the same codebase >0 -> wait for them to land first, then reject the dead one.
- This is the inverse of `factory-reject-nukes-untracked-files.md`: that pattern protects conductor untracked files; this caveat protects concurrent Factory sessions.

## Why

`reject_factory_session` performs a worktree clean as a side effect (see `factory-reject-nukes-untracked-files.md`). It deletes ALL untracked files including legitimate conductor-side work, and it discards 25+ minutes of session context.

`resume_cc_session` keeps the session's full context intact, preserves the worktree, and lets the same session retry with a corrected understanding. The cost is a few SDK turns; the gain is preserved context, no untracked-file loss, and faster path-to-shipping.

In phantom-session cases specifically (session's reported diff doesn't match what's on disk), resume is provably the right move - the session has completed without doing the work, so giving it a clear list of "you didn't do X, Y, Z, do them now" with concrete grep/ls commands as evidence is exactly the redirection the SDK was designed for.

## Do

- Before reject, ask: "could `resume_cc_session` with a clear correction message recover this?" The answer is yes 90% of the time.
- Build the resume message from on-disk verification: include the exact failing grep/ls/test commands and their output (or "ZERO matches" / "No such file"). Concrete evidence forces the next turn to actually verify.
- When using `send_cc_message` mid-flight: keep it terse. The session already has the spec. State only the new constraint or course-correction.
- When using `resume_cc_session` after completion: reproduce the original deliverables list compactly + flag what's missing + restate the [FORK_REPORT] gating condition.
- Commit any conductor-side untracked files BEFORE you reach for reject (per `factory-reject-nukes-untracked-files.md`). Reject is destructive to the conductor's working tree.

## Do not

- Do not reject and re-dispatch as a default response. That burns context, untracked files, and ~25 min per cycle.
- Do not assume a phantom session is unrecoverable. Phantoms usually mean the session emitted [FORK_REPORT] without doing the work - resume with on-disk evidence is exactly the fix.
- Do not chain "reject -> redispatch with hardened prompt" when "resume with corrected redirect" achieves the same outcome at lower cost.
- Do not reject because the diff metadata is misleading (Mode-2 phantom). Verify on disk first (factory-metadata-trust-filesystem doctrine), then redirect via resume if real work is missing.

## Protocol on Factory completion notification

```
1. mcp__factory__review_factory_session sessionId=<id>
2. Verify deliverables ON DISK (grep, ls, test). DO NOT trust filesChanged metadata.
3. If all deliverables present and correct: approve_factory_deploy.
4. If any deliverable missing or wrong:
   a. Construct a redirect message with concrete on-disk evidence (failing grep output, missing file paths).
   b. resume_cc_session(sessionId, redirectMessage).
   c. Schedule next review in 15-20 min.
5. Reject ONLY if resume has already failed OR session has done destructive work.
```

## Origin

Apr 27 2026, 13:29 AEST. Tate flagged the reject-and-redispatch reflex as wasteful: "you could just redirect the chat to make changes you wwant to the work its done instead of it having to restart completelkery.... that should be a reflxive thing right?"

Context: Factory session a3288300 (fork send_message capability re-dispatch after a32be744 phantom-rejected) produced a second phantom - filesChanged metadata claimed conductor-side commit 893fe11 (patterns/INDEX.md + factory-reject-nukes-untracked-files.md) as session output, but on-disk verification showed zero target deliverables. Default reflex would have been to reject and re-dispatch a third time. Tate's correction landed exactly when the choice was about to be made. Applied the new doctrine: resumed a3288300 with concrete on-disk evidence of missing deliverables, preserved the session context, kept untracked-file safety.

The `resume_cc_session` MCP tool itself had a bug (sent `{message}` instead of `{content}` per `src/routes/claudeCode.js:179`), forcing a curl-direct workaround. That bug fix is being bundled with the scheduler-defer architectural fix in the next Factory PR.
