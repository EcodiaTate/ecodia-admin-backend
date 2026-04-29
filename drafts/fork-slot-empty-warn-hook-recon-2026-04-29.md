# [FORK-SLOT-EMPTY WARN] Hook Recon — 2026-04-29

**Status:** RECON-ONLY. Implementation pending Tate-review of this doc + a follow-up fork.

**Trigger event:** 29 Apr 2026, third strike on the continuous-work doctrine. Tate 17:03 AEST: "you need to add it to your claude.md that you have 5 forks at any given time, why would you jsut be sitting stil." First strike 13:17 (fork-by-default), second 14:35 (conductor-never-idle), third 17:03 (5-forks-always). Per `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` and the third-strike threshold, this is the moment to scope the mechanical enforcement layer.

**Authoring fork id:** fork_mojpn3c6_d246ba.

---

## 1. The signal we want to surface

`[FORK-SLOT-EMPTY WARN] N/5 fork slots active, M empty. Next dispatch is mandatory before any further conductor work.`

This warn line should appear in model-visible context (additionalContext on a hook stdout, or system-prompt-injection on cron-fire / Tate-message ingress) at every moment the conductor is awake AND fork count < 5. It should fire ON THE TOOL CALL THAT FOLLOWS a fork landing, not be deferred to a periodic poll, because the conductor often takes 2-3 reflexive tool calls between fork-land and the next dispatch decision.

Warn-only, never blocks. Same posture as the existing four hooks (`brief-consistency-check.sh`, `cred-mention-surface.sh`, `doctrine-edit-cross-ref-surface.sh`, `status-board-write-surface.sh`, `fork-by-default-nudge.sh`).

---

## 2. Where would the hook fire?

**Option A — PreToolUse on every tool call.**
- Pro: Maximum coverage. Every conductor action is gated by an awareness check.
- Con: 100-500x noisier than the other hooks. Could overwhelm model-visible context with `[FORK-SLOT-EMPTY WARN]` on grep/Read/db_query tool calls where the warning is moot (conductor is already mid-orientation).
- Verdict: too noisy without an allow-list. Allow-list mirrors `fork-by-default-nudge.sh` (skip Read/Grep/Glob/db_query/etc).

**Option B — PreToolUse only on conductor-action tools.**
- Allow-list approach: fire only on tools that represent "the conductor doing something other than orientation": `mcp__forks__spawn_fork` (spawn-time), `Bash`, `Edit`, `Write`, `mcp__supabase__db_execute`, `mcp__google-workspace__gmail_send`, `mcp__sms__send_sms`, `mcp__factory__start_cc_session`.
- Pro: Fires at the exact moments where "is my fork-bench full?" is the relevant question. If the answer is no and I'm about to send an email or write a file, I should be dispatching a fork in parallel.
- Con: Slight risk of double-firing alongside `fork-by-default-nudge.sh` on the same call. Mitigated by emitting a single combined nudge if both fire.
- Verdict: **PREFERRED.** Pairs naturally with the existing fork-by-default hook.

**Option C — PostToolUse after `mcp__forks__list_forks` returns < 5 active.**
- Pro: Very specific signal (the conductor literally just learned the count is low).
- Con: I rarely call `list_forks` proactively. The value is in surfacing the warning when I DON'T think to check.
- Verdict: complementary, not a replacement for B.

**Option D — Periodic injection on cron-fire and Tate-message ingress.**
- Pro: Covers the cold-start case where the conductor wakes up to a cron-fire and needs the fork-count surfaced before deciding what to do.
- Con: Requires backend code changes (already documented as pending in `~/ecodiaos/drafts/context-surface-injection-points-recon-2026-04-29.md`).
- Verdict: **CHAINED — ship after B is live.** This is the same injection-layer work that would surface trigger-keyword matches; bolt fork-count onto the same surface.

**Recommendation:** Ship Option B first. Add Option C as a complement. Bundle Option D into the broader injection-layer work tracked in the existing recon doc.

---

## 3. How does the hook query current fork count?

This is the hard part. `mcp__forks__list_forks` is an MCP tool, not directly callable from a bash hook process.

**Options:**

**3a. HTTP call to the local fork-manager service.**
If the fork-manager exposes a `GET /api/forks/active` endpoint on `localhost`, the hook can `curl -s http://localhost:PORT/api/forks/active | jq '. | length'` and compare to 5. Cost: 5-50ms per invocation. This is the cleanest path.

Action item: confirm the fork-manager service exposes such an endpoint, or add one. Likely lives in `src/services/forkManager.js` (or similar). Recon needed before implementation.

**3b. Direct DB query.**
If active forks are stored in a Postgres table (e.g. `forks` or `fork_sessions`), the hook can `psql -c "SELECT COUNT(*) FROM forks WHERE status = 'active'"`. Cost: 20-100ms per invocation, plus connection overhead. Requires DB credentials in the hook environment, which adds attack surface for hook code.

**3c. Filesystem heartbeat / lock file.**
The fork-manager could maintain a lock-file directory `~/ecodiaos/run/forks/` with one file per active fork. The hook reads `ls -1 ~/ecodiaos/run/forks/ | wc -l`. Cost: under 5ms. Simplest. Requires the fork-manager to maintain the lock-file dir, which is a small extension.

**Recommendation:** 3c (filesystem heartbeat) for speed and simplicity, with 3a as a fallback if the fork-manager already has an HTTP endpoint. 3b is the worst option (heaviest, biggest attack surface).

---

## 4. Debounce and noise control

**Risk:** rapid fork landings cause repeated `[FORK-SLOT-EMPTY WARN]` injections within a few seconds. If forks 3, 4, 5 land within 30s of each other, the conductor gets three consecutive warns in three consecutive turns. That's noise, not signal.

**Debounce window:** 90 seconds. Once a `[FORK-SLOT-EMPTY WARN]` fires, suppress further warns for 90s. State stored in `~/ecodiaos/run/last-fork-slot-warn` (touch file with timestamp). Hook reads `stat -c %Y` against current time.

**Suppression unless slot-count actively dropped:** if the count is 4 at warn-time and is still 4 90s later, the warn was already delivered. Only re-warn if the count decreased further (e.g. from 4 to 3) OR if 5 minutes have passed without the conductor topping up.

**Hard-floor escalation:** if fork count reaches 0 and stays at 0 for 60s, escalate to a louder warn: `[FORK-BENCH EMPTY - DISPATCH IMMEDIATELY]`. This is the catastrophe state.

---

## 5. Implementation skeleton

```bash
#!/usr/bin/env bash
# fork-slot-empty-warn.sh
# PreToolUse hook. Fires on conductor-action tool calls. Reads current
# fork count from filesystem heartbeat dir. Emits warn if < 5.
# Warn-only, never blocks. Debounced 90s.

set -u
input=$(cat)
if ! echo "$input" | jq -e . >/dev/null 2>&1; then exit 0; fi
tool_name=$(echo "$input" | jq -r '.tool_name // empty')

# Allow-list mirrors fork-by-default-nudge.sh
case "$tool_name" in
  mcp__forks__*|Read|Grep|Glob|LS|TodoWrite|WebSearch|WebFetch) exit 0 ;;
  mcp__supabase__db_query|mcp__supabase__db_list_tables|mcp__supabase__db_describe_table) exit 0 ;;
  mcp__crm__*|mcp__neo4j__graph_query|mcp__neo4j__graph_search|mcp__neo4j__graph_schema) exit 0 ;;
  mcp__google-workspace__gmail_list_*|mcp__google-workspace__gmail_get_*|mcp__google-workspace__calendar_list_*) exit 0 ;;
  mcp__scheduler__schedule_list|mcp__factory__get_*|mcp__factory__list_codebases) exit 0 ;;
esac

# Debounce: 90s suppression after last warn.
warn_file="$HOME/ecodiaos/run/last-fork-slot-warn"
now=$(date +%s)
if [ -f "$warn_file" ]; then
  last=$(stat -c %Y "$warn_file" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 90 ]; then exit 0; fi
fi

# Read fork count from filesystem heartbeat dir.
fork_dir="$HOME/ecodiaos/run/forks"
if [ ! -d "$fork_dir" ]; then exit 0; fi  # heartbeat not maintained, skip
active=$(ls -1 "$fork_dir" 2>/dev/null | wc -l)
target=5

if [ "$active" -ge "$target" ]; then exit 0; fi

empty=$((target - active))
mkdir -p "$(dirname "$warn_file")" && touch "$warn_file"

if [ "$active" -eq 0 ]; then
  echo "[FORK-BENCH EMPTY] 0/5 forks active. Dispatch immediately - this is a catastrophe state per ~/ecodiaos/patterns/continuous-work-conductor-never-idle.md" >&2
else
  echo "[FORK-SLOT-EMPTY WARN] $active/5 fork slots active, $empty empty. Per CLAUDE.md '5 forks always - empty slots are failure', dispatch a fork before further conductor work." >&2
fi

# Emit additionalContext for model-visible surfacing.
jq -n --arg active "$active" --arg empty "$empty" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: ("[FORK-SLOT-EMPTY WARN] " + $active + "/5 fork slots active, " + $empty + " empty. Dispatch a fork before further conductor work.")
  }
}'

exit 0
```

---

## 6. Settings.json registration

Add to `.claude/settings.json` PreToolUse hooks list:

```json
{
  "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__vps__shell_exec|mcp__supabase__db_execute|mcp__supabase__storage_upload|mcp__supabase__storage_delete|mcp__google-workspace__gmail_send|mcp__google-workspace__gmail_reply|mcp__google-workspace__gmail_create_draft|mcp__sms__send_sms|mcp__factory__start_cc_session|mcp__forks__spawn_fork",
  "hooks": [
    {
      "type": "command",
      "command": "$HOME/ecodiaos/scripts/hooks/fork-slot-empty-warn.sh"
    }
  ]
}
```

Note: `mcp__forks__spawn_fork` IS included as a matcher because the warn should fire BEFORE the spawn lands - the conductor sees "you're about to bring it from 4/5 to 5/5, good. But if you were at 2/5, this single dispatch isn't enough."

---

## 7. Heartbeat-dir maintenance (the missing piece)

The hook depends on `~/ecodiaos/run/forks/` being kept current. The fork-manager must:

1. On fork spawn: `touch $HOME/ecodiaos/run/forks/<fork_id>`
2. On fork land/abort: `rm $HOME/ecodiaos/run/forks/<fork_id>`
3. On startup: scan in-flight forks from DB and write the dir state.

This is a 10-line addition to the fork-manager service, but it has to ship BEFORE the hook is enabled, otherwise the hook reads an empty dir and warns on every call.

**Implementation order:**
1. Heartbeat-dir maintenance in fork-manager. Forklike, ship via Factory or SDK fork.
2. Hook script lands in `~/ecodiaos/scripts/hooks/fork-slot-empty-warn.sh`.
3. Settings.json registration.
4. Verify with a manual test: spawn 2 forks, dispatch a Bash call, confirm warn fires.

---

## 8. Risk assessment

| Risk | Mitigation |
|---|---|
| Hook spams on rapid fork-landings | 90s debounce + only re-warn on count decrease |
| Heartbeat-dir gets out of sync with reality | Periodic reconciliation cron (every 10min) compares dir state to DB-reported active forks |
| Hook fires during legitimate orientation moments | Allow-list of read-only / orientation tools mirrors fork-by-default-nudge.sh |
| Conductor games the rule by spawning low-quality forks to hit 5 | Quality gate: each fork brief must pass the brief-consistency-check.sh hook (which already exists) |
| 0/5 catastrophe state during cold-start gets warned-then-suppressed | Hard-floor escalation to `[FORK-BENCH EMPTY]` louder line, which bypasses debounce |

---

## 9. Open questions for Tate-review

1. **Is 5 the right number?** Tate stated 5 verbatim. But if the model context budget genuinely supports more (or less, at peak load), we should treat 5 as a strong default with the option to bump to 7-8 during deep-work sessions and floor to 3 when Tate is actively in the chat. Recommend: ship 5/5 fixed, revisit after 1 week of operation.

2. **Should the hook also fire on `mcp__factory__start_cc_session`?** Factory sessions are "fork-like" but live on a separate Claude account. They don't count against the 5-fork limit but they DO count against the conductor's continuous-work obligation. Recommend: include Factory dispatches in a "total parallel work" count if we want, but for this hook keep it strictly fork-count.

3. **Does the warn also surface on cron-fire prompts?** Per the broader injection-layer work in `context-surface-injection-points-recon-2026-04-29.md`, cron-fires don't go through PreToolUse hooks. The fork-count surface there would need to be done at the prompt-injection level inside `osSessionService` or `schedulerPollerService`. Recommend: chain after this hook ships.

---

## 10. Status_board entry

P3 row inserted by fork_mojpn3c6_d246ba: "[FORK-SLOT-EMPTY WARN] hook implementation queue: heartbeat-dir + hook script + settings.json registration. Recon doc shipped." `next_action_by=ecodiaos`, `next_action="dispatch fork to implement heartbeat-dir maintenance in fork-manager, then ship hook script"`.

---

## 11. Decision required from Tate

(a) Approve recon and authorise implementation fork (heartbeat-dir + hook script + settings.json registration).
(b) Confirm 5 is the production target (vs. 3 / 7 / dynamic).
(c) Confirm allow-list scope matches the existing four hooks.

If a fourth strike on the continuous-work doctrine fires before this is shipped, the implementation fork should be dispatched without waiting for (a)-(c) - per the third-strike doctrine, mechanical enforcement ships on the strike that proves doctrine alone insufficient.
