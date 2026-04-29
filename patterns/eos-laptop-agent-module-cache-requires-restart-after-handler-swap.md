---
triggers: agent restart, eos-laptop-agent restart, module cache, require cache, handler swap, stub swap, hot reload, file write no effect, macroSuite stale, tool not picking up, corazon agent restart, sy094 agent restart, pm2 restart eos-laptop-agent, node module cache, require.cache, hot patch
priority: high
canonical: true
---

# eos-laptop-agent caches required modules on first load - swapping a handler file requires an agent restart, not just a file write

## Rule

When you write or replace a `tools/*.js` or `macroHandlers/*.js` file on `eos-laptop-agent` (Corazon or SY094), the new content does NOT take effect until the agent process is restarted. Node's `require()` caches modules in `require.cache` keyed by absolute path. The agent's index.js loads each handler once at boot via `require('./tools/<name>')` and the cached module object persists for the life of the process.

A `filesystem.writeFile` to `D:\.code\eos-laptop-agent\tools\github-login.js` updates the file on disk. A subsequent dispatch of `chrome.someTool` or `macroSuite.run('github-login')` runs the OLD module loaded at boot. Until you `pm2 restart eos-laptop-agent`, the swap is invisible to the dispatch surface.

## Detection

If you swap a handler and dispatch immediately:
- The agent's response will be the OLD behaviour (old coordinates, old throw message, old return shape).
- `macroSuite.list` may show the OLD `description` even after the file's `description` changed.
- A handler swapped from real-implementation → stub will continue to attempt the real action and may click wrong pixels.

## Required pattern

After ANY write to `tools/*.js`, `macroHandlers/*.js`, or `index.js` on the agent:

1. **Restart the agent.** Via `shell.shell` tool: `pm2 restart eos-laptop-agent`.
2. **Wait for boot.** ~3 seconds for the agent to come back up.
3. **Verify dispatch surface.** Call `macroSuite.list` (or the equivalent for the touched tool) and confirm the new `description` / `name` is reflected.
4. **Verify behaviour.** Dispatch the swapped handler and confirm the new behaviour (e.g. for a stub: confirm it throws the documented Phase 1 stub error; for a real handler: confirm it returns the new shape).

The verification step is non-skippable. Without it, you can't tell if your write went to the right path, if the file is syntactically valid (Node would have logged a parse error on restart), or if the registry actually picked up the change.

## On Corazon specifically

PM2 process name: `eos-laptop-agent`. Restart command via `shell.shell`:

```bash
pm2 restart eos-laptop-agent
```

After restart, the agent is reachable at `http://100.114.219.69:7456` again within ~3 seconds. The auth token (`creds.laptop_agent`) does not change across restarts. No CDP relaunch happens (the agent uses puppeteer attach-only via :9222, separate from the agent's own lifecycle).

## On SY094 specifically

PM2 process name: `eos-laptop-agent` (same convention). Restart via `pm2 restart eos-laptop-agent` over SSH or via the agent's own `shell.shell` if it's running. Pattern is identical except agent is reachable on `localhost:7456` over SSH tunnel rather than direct Tailscale.

## Do

- Always plan a `pm2 restart eos-laptop-agent` step into any brief that swaps a handler file.
- Verify with `macroSuite.list` (or equivalent) AFTER restart, not before.
- If swapping multiple handlers in sequence, batch the writes and restart ONCE at the end. Do not restart per-file.
- If you can't restart the agent for a reason (Tate is mid-flow on the laptop, agent is processing a long task), record the swap as "shipped-but-pending-restart" in status_board with the restart action owned.

## Do not

- Do NOT assume `filesystem.writeFile` activates the new behaviour.
- Do NOT verify the swap by re-reading the file via `filesystem.readFile` and seeing the new content - that confirms the write succeeded, not that the agent picked it up.
- Do NOT leave a handler in a half-swapped state (file new, module cached old) overnight - the next dispatch will use the old behaviour silently.
- Do NOT use `delete require.cache[...]` workarounds in the agent's tool dispatcher to enable hot-reload. The tradeoff (introducing leak surfaces, breaking idempotency assumptions, complicating debug) is not worth saving the 3 seconds of restart.

## Briefing protocol

When writing a fork brief that swaps `tools/*.js` or `macroHandlers/*.js` on the agent, the brief MUST include:

```
After writing all files, run: pm2 restart eos-laptop-agent (via shell.shell)
Wait 3 seconds.
Verify: call macroSuite.list (or equivalent) and confirm new descriptions appear.
Verify: dispatch the changed handler and confirm new behaviour.
```

If the brief omits this, the conductor's review pass should catch the gap and send a clarifying message before the fork reports done.

## Cross-references

- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` - Phase 1 observation rule. Stub-replacement work is a frequent trigger for this restart issue because the swap is the ENTIRE point and silent-no-op is the worst case.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the broader Corazon doctrine. The agent is a peer; treating it as a peer means understanding its process lifecycle.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - "I wrote the file, the swap is shipped" without verification is symbolic. The restart + dispatch verify IS the proof.
- `~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md` - same family: never assume your write took effect, verify behaviour.
- `~/ecodiaos/docs/secrets/laptop-agent.md` - Corazon agent token + PM2 process metadata.

## Origin

29 Apr 2026, 17:48 AEST. Fork fork_mojquxhy_2a5b93 executed Option A on the macro retraction (replacing 6 hallucinated `macroHandlers/*.js` files with stub-only versions). Mid-execution the fork wrote all 6 stub files, called `macroSuite.list`, and observed that `description` fields had NOT updated to the new "STUB. Requires Phase 2 record-mode pass" text. Diagnosis: Node `require.cache` held the original modules from agent boot.

The fork's recovery: dispatched `pm2 restart eos-laptop-agent` via `shell.shell`, waited, re-listed, confirmed all 6 descriptions reflected the new stub state, then verified `macroSuite.run github-login` threw the documented stub error.

The fork's reported `next_step`: "any future stub/handler swap needs a planned restart, not just a file write." That observation IS this doctrine. Codifying so the next stub-swap brief includes the restart step at brief-render time rather than discovering the gap mid-flight.
