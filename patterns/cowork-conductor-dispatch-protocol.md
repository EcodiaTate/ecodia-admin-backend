---
triggers: cowork-conductor, cowork-dispatch, claude-desktop-dispatch, conductor-dispatch, side-panel-dispatch, ui-driving-protocol, dispatch-primitive, conductor-instruct-cowork, cowork-bounded-step, cowork-screenshot-verify, cowork-pre-dispatch-check, cowork-account-state, cowork-account-revert, claude-desktop-app, cowork-feature, claude-in-chrome-beta, dispatch-checklist, cowork-vs-claude-in-chrome, ctrl-e, dispatch-bounded-step
priority: critical
canonical: true
---

# Conductor -> Cowork dispatch protocol - bounded steps, verified state, account-revert aware

## 1. The rule

When the conductor (or a fork) hands a UI-driving task to Claude Cowork (or to Claude in Chrome), the dispatch is a discrete, bounded, single-step instruction with a screenshot verification on each turn. The conductor verifies Cowork's account+usage state at the START of every dispatch, not just once at session boot. Account-revert is a known recurring failure mode on Corazon: Claude Desktop holds OAuth tokens for multiple Anthropic Workspace organisations simultaneously and silently switches the active workspace back to the default (currently tate@ecodia.au) on session boundaries, restarts, or 5-hour Max-plan windows. A stale-account dispatch will fail with credit exhaustion AND look like a Cowork bug instead of an account bug. The pre-dispatch verification check exists to catch the revert before the dispatch burns tokens.

## 2. Vocabulary - two distinct Anthropic features under the "Cowork" umbrella

Tate's 20:25 AEST 29 Apr 2026 directive ("claude cowork is just the 1stop shop which you need to be religiously using") covers TWO distinct Anthropic-shipped features that the prior doctrine `claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` conflated. Verified on Corazon Settings > Sidebar 21:08 AEST 29 Apr 2026:

- **Cowork (Dispatch [Beta])** = Claude Desktop standalone-app feature. "Let Claude work on tasks from your phone using this computer. When off, your phone won't be able to dispatch work here." Lives at Settings > Cowork > Dispatch toggle. Currently ON. Has a Global instructions field (currently empty). This is the autonomous-agent-on-the-laptop feature; it is NOT a Chrome side panel. The conductor->Cowork dispatch primitive INSTRUCTS THIS by typing into Claude Desktop's chat input.
- **Claude in Chrome [Beta]** = a Chrome extension/native-host bridge that drives the Chrome browser DOM via Cowork's agent loop. Lives at Settings > Claude in Chrome [Beta] > Default for all sites policy. The Chrome extensions allowed by the native host are `dihbgbndebgnbjfmelmegjepbnkhlgni`, `fcoeoabgfenejglbffodgkkbkcdhcgfn`, `dngcpimnedloihjnnfngkgjoidhnaolf` (per `ChromeNativeHost\com.anthropic.claude_browser_extension.json`). This is the side-panel-on-a-webapp feature.

Both are reached through the same Claude Desktop process (claude.exe, MSIX `Claude_pzs8sxrjxfjjc`). The conductor instructs Cowork the same way regardless of which substrate Cowork uses to act: bounded natural-language instruction into Claude Desktop's chat input, screenshot to verify, decide next step.

The Ctrl+E shortcut in Tate's Chrome opens Chrome's tab-search overlay, NOT the Claude side panel. The prior doctrine's claim that "input.shortcut [ctrl+e] opens the Cowork side panel" is wrong in the current Corazon Chrome configuration. The actual side panel for Claude in Chrome opens via the extension toolbar icon OR the extension's own configured shortcut (if Tate has set one in chrome://extensions/shortcuts). Until the extension shortcut is verified, the dispatch primitive should target Claude Desktop's main chat window directly, NOT a Chrome side panel.

## 3. Pre-dispatch verification checklist (run on EVERY dispatch, not just boot)

The conductor MUST run all four checks in order before any Cowork dispatch. A failed check halts the dispatch and surfaces to status_board.

1. **Claude Desktop process alive.** `process.listProcesses` filtered to `claude` - the main window process (title "Claude") must exist with a non-zero MainWindowHandle. If absent, the dispatch is impossible until Claude Desktop is launched.
2. **Account+org verified.** Read `C:\Users\tjdTa\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\config.json` and check the most-recent `dxt:allowlistLastUpdated:<orgId>` timestamp. The org with the latest timestamp is the currently-active workspace. Cross-reference against the known mapping: `04e9a0fe-5d08-40da-9f31-2403f162515d` = tate@ecodia.au (default), `5f2d88ab-726e-40b9-b022-704d6df07474` = code@ecodia.au (per 29 Apr 2026 evidence). If the active org is NOT the org we want for this dispatch, attempt a workspace switch via the Claude Desktop sidebar (account selector), or surface to status_board as `next_action_by=tate` if the GUI selector cannot be driven reliably.
3. **Usage budget sufficient.** Open Settings > Usage and screenshot. If "Current session resets in" shows under 30 min OR "All models" weekly bar shows over 90% used, defer the dispatch (it will hit credit-exhaustion mid-task and the post-revert recovery is expensive). The verified Max-20x state at 21:04 AEST 29 Apr was: current session 23% used (resets 4hr 26min), all-models weekly 37% (resets Fri 11:00 AM), Sonnet weekly 25%.
4. **Cowork toggle ON.** Open Settings > Cowork. Confirm Dispatch toggle is enabled. If off, the dispatch surface is nominally usable from the laptop side but the phone-dispatch path is dead; flag in the dispatch result.

The four checks compose into a 4-call probe (`process.listProcesses`, `filesystem.readFile config.json`, two screenshots). Total wall-clock: under 10 seconds. The cost of skipping the checks is one stale-account dispatch (typically 100-500 tokens of Cowork work plus the conductor's review pass = 2k-5k tokens wasted).

## 4. Dispatch protocol - the bounded-step loop

Once the pre-dispatch checks pass:

1. **Focus Claude Desktop.** AppActivate via `[Microsoft.VisualBasic.Interaction]::AppActivate($pid)` is unreliable on Windows due to focus-stealing protection. Use the P/Invoke approach: `SetWindowPos h HWND_TOPMOST 0 0 0 0 SWP_NOMOVE|SWP_NOSIZE`, sleep 200ms, `SetWindowPos h HWND_NOTOPMOST 0 0 0 0 SWP_NOMOVE|SWP_NOSIZE`. Verified working 21:04 AEST 29 Apr 2026 on Claude Desktop PID 24876. The full code lives in this file under Section 9 as a reusable PowerShell snippet.
2. **Screenshot the focused state.** `screenshot.screenshot` returns the OS-level PNG. Inspect: is the chat input visible? Is there a pending modal? Is the right-side panel showing a previous Cowork run still in progress? If a prior run is mid-flight, do NOT issue a new instruction - either wait for it to finish (poll screenshot on a short interval) or surface as a conflict.
3. **Click into the chat input.** Locate the chat input bar in the screenshot (typically near the bottom of the window). Click into it via `input.click {x, y}`.
4. **Type the bounded instruction.** `input.type {text}` - one bounded discrete step. Examples of bounded steps:
   - `Open Tate's Chrome and navigate to https://vercel.com/dashboard. Screenshot what you see.`
   - `In the Stripe dashboard, find the most recent invoice for customer Resonaverde and copy the invoice number.`
   - `On the GitHub web page that's already open, click the "New pull request" button and paste this title: <title>. Do NOT submit.`
   The instruction MUST end at a verifiable state-change point. Multi-step plans get fragmented: the conductor issues step 1, screenshots, issues step 2, screenshots. Cowork has no externally-exposed abort or question-surface API to the conductor.
5. **Submit.** `input.key {key: "enter"}`.
6. **Poll for completion.** Take a screenshot every 5-15 seconds. Cowork shows progress in the right-side panel ("Progress", "Working folder", "Context"). When the chat shows a final assistant message AND the right-side panel shows no active task indicator, the step is complete.
7. **Verify outcome.** Screenshot the relevant target surface (the web page Cowork was driving, or the desktop app). Cowork's natural-language confirmation in the chat is the primary signal; the target screenshot is the cross-check. If the two disagree, trust the target.
8. **Persist into the conductor's logs.** Save the screenshot to `~/ecodiaos/drafts/cowork-dispatch-<fork_id>-<step>.png`. Write a Neo4j Episode IF the dispatch is part of a tracked workstream. Update status_board if the dispatch advances a tracked thread.

## 5. Pre-conditions, post-conditions, error handling

**Pre-conditions** (all must hold before step 4.4 above):
- Claude Desktop is the foreground window AND its main chat input is empty (no in-flight Cowork run).
- The active workspace is the workspace authorised for the dispatch (typically code@ecodia.au for autonomous work).
- The Cowork Dispatch toggle is ON (Settings > Cowork).
- The current-session usage is under 90%.
- The conductor has captured a "before" screenshot for the audit trail.

**Post-conditions** (all must hold after step 4.7):
- A "after" screenshot is captured.
- Cowork's chat shows a terminal assistant message (not "thinking..." or a tool call in flight).
- The target surface (web page, desktop app, file system) is in the goal_state described in the brief, OR the dispatch is recorded as failed with the specific failure mode.

**Error handling**:
- **Account-revert detected mid-dispatch** (e.g. usage indicator suddenly shows credit exhaustion, or the workspace-selector visibly shows a different account): abort the dispatch immediately. Save the current chat state by screenshot. Surface to status_board with the recurring-revert tag.
- **Cowork is stuck on a question/modal in the side panel**: the conductor cannot answer Cowork's question via the conductor's tool surface (Cowork has no externally-exposed question.surface API). Screenshot the question. Either (a) pre-resolve the ambiguity in a fresh dispatch with the disambiguation baked in, or (b) surface to Tate via SMS for a one-line answer he can type in directly.
- **Cowork ignores the instruction or does the wrong thing**: do NOT issue a corrective follow-up in the same chat (the conductor cannot wholesale-redirect a confused Cowork run). Click the "abort" or "stop" button visible in Cowork's UI, screenshot, then issue a fresh bounded instruction.
- **Window focus lost mid-typing**: input.* may type into the wrong window if focus changes mid-typing. Re-focus Claude Desktop, screenshot to confirm the chat input is still selected, and re-type from scratch. Typing fragments into the wrong window must be cleaned up (Ctrl+A, Delete) before the bounded instruction is re-typed.

## 6. Why the conductor still owns the loop, not Cowork (carried forward from the parent doctrine)

Cowork is an agent. The conductor is also an agent. They are not peers in our architecture. The conductor owns the durable state, the audit trail, and the kill switches. Cowork is invoked as a discrete capability per bounded step, not handed the loop wholesale. Specifically:

- **Cowork has no externally-exposed `abort.check`.** If a Cowork run goes wrong, only Tate's keyboard at the laptop can stop it. The conductor cannot terminate a Cowork run from outside without driving the GUI's stop button. Therefore the conductor instructs Cowork in bounded discrete steps, never a long open-ended directive that Cowork might run with for minutes.
- **Cowork has no externally-exposed `question.surface` API.** When Cowork's model needs human input mid-run, Cowork asks Tate via the chat UI, not the conductor. The conductor would not even know a question was asked unless it screenshots and reads. Therefore the conductor pre-resolves ambiguities in the brief before instructing Cowork.
- **Cowork's run log is internal to the chat.** The conductor's durable logs (status_board updates, Neo4j Episodes, screenshot trails, decision provenance) need to be authored by the conductor wrapping Cowork. Cowork's own chat log is not the audit surface.
- **Cowork is a single-window process.** It cannot orchestrate across browsers, machines, or non-laptop state. The conductor is multi-machine, multi-substrate; it owns the orchestration.

The protocol consequence: the conductor instructs Cowork in a discrete bounded step ("do X, screenshot result"), waits, screenshots, decides next step, then issues the next bounded instruction. NOT a long open-ended "do all of X for me" directive.

## 7. Anthropic-first design check (why we did NOT build a new MCP primitive this turn)

The brief asked whether to wrap the [shortcut + input.type + screenshot] loop in a new MCP primitive on `eos-laptop-agent`. The answer is NO - default-against, with an explicit gap-memo.

Per `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md`, before building any new agent primitive, check Anthropic's tool surface for an existing capability. The existing capabilities relevant here:

- **Anthropic computer-use API.** Already exposed; gives screenshot + click + type + key + scroll in a single tool-use schema. The conductor could call it directly as a Claude tool-use action. Why not USE this directly to drive Claude Desktop? Because the conductor doesn't have computer-use API access today (it runs on the SDK stream, not via tool-use computer-use directly), AND Claude Desktop is itself a Cowork host. Calling computer-use to drive a computer-use host is the same loop twice over. The peer-paradigm `input.* + screenshot.*` tools on `eos-laptop-agent` ARE already the canonical OS-level peer-paradigm primitive on Corazon; they are the right tools for driving the Claude Desktop chat input.
- **Claude Cowork's own dispatch surface.** Cowork has a phone-dispatch endpoint (Dispatch toggle ON in Settings > Cowork). The phone-dispatch is a USER-FACING dispatch (Tate's iPhone or another Claude.ai surface) - it does not expose a programmatic endpoint to the conductor. Verified by grep: no public Anthropic API for "dispatch a Cowork task". Native messaging bridge `claude-mcp-browser-bridge-tjdTa` exists but is stdio + extension-allowlisted to three specific Chrome extensions (per the ChromeNativeHost manifest), not a TCP/HTTP listener for third-party invocation.
- **Claude in Chrome Native Host.** The native host process `chrome-native-host.exe` listens on a Windows pipe (`\\.\pipe\claude-mcp-browser-bridge-tjdTa`). Could the conductor connect directly to this pipe and inject MCP traffic? Possibly, but this is undocumented Anthropic-internal IPC; building against it is parallel infrastructure to a private API. Defer.

The gap-memo: there is no Anthropic-shipped programmatic dispatch endpoint for Cowork. The natural-language `input.type` into Claude Desktop's chat IS the canonical user-facing dispatch surface. Wrapping this in an MCP primitive on `eos-laptop-agent` would (a) duplicate `input.* + screenshot.*` (already shipped, already documented), (b) add no observability the conductor can't already get by reading screenshots, (c) drift the moment Anthropic ships a real programmatic endpoint.

**Decision: do NOT build an MCP wrapper.** The conductor uses the existing peer-paradigm tools per Section 4 above. This pattern file IS the durable doctrine; the natural-language documentation IS the substitute for the wrapper. If Anthropic ships a programmatic Cowork dispatch endpoint, this section gets re-evaluated.

## 8. Recurring drift - the account-revert phenomenon

**Observed 29 Apr 2026.** Claude Desktop reverts the active workspace from code@ecodia.au back to tate@ecodia.au within minutes of the swap, multiple times across multiple sessions. Tate's report at 21:01 AEST: "it switched back to tate@ and killed all the forks again as well."

**Evidence collected this fork (fork_mojy0izs_f73f7c, 21:00-21:10 AEST 29 Apr 2026):**

- `config.json` holds `dxt:allowlistEnabled` and `dxt:allowlistLastUpdated` for BOTH org IDs simultaneously - Claude Desktop is signed in to BOTH workspaces via OAuth at the same time. The encrypted `oauth:tokenCache` field is a single combined cache.
- Latest `dxt:allowlistLastUpdated` per org:
  - `5f2d88ab-726e-40b9-b022-704d6df07474` -> 2026-04-29T10:35:47Z (20:35 AEST) - believed to be code@ecodia.au, the previously-active workspace.
  - `04e9a0fe-5d08-40da-9f31-2403f162515d` -> 2026-04-29T10:53:15Z (20:53 AEST) - currently active, matches Account page Organization ID, believed to be tate@ecodia.au.
- The 18-minute window between the two timestamps aligns with Tate's report of the auto-revert.
- `bridge-state.json` still references the older org (`5f2d88ab`) for the bridge-enabled session. The bridge is NOT auto-following the active workspace - this is a SECOND independent mismatch.
- `oauth:tokenCache` is encrypted and not introspectable without the OS-level DPAPI key.

**Most likely root cause hypothesis:** Claude Desktop's workspace selector defaults to the most-recently-paid-active workspace on session/restart boundaries. The "default" appears to be tate@ecodia.au for this Corazon install regardless of which workspace was last manually selected. When the 5-hour session boundary fires OR the app refreshes its OAuth tokens, the active workspace silently flips to default.

**Hypotheses still in scope** (not yet falsifiable from current evidence):
- 5-hour Claude Max session boundary on tate@ auto-rotating active workspace back.
- Claude.ai web logged in as tate@ feeding shared cookies to the desktop session.
- Auto-update reverting active workspace via post-update launch defaults.
- Multiple sign-in profiles inside Claude Desktop with one set as default and a "remember default" preference that overrides ad-hoc switches.

**Mechanical fix consideration.** Per `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md`, this is the second-third recurrence today and meets the threshold for mechanical enforcement. The pre-dispatch verification checklist in Section 3 is the doctrinal layer; the mechanical layer would be:
- A scheduled probe (`schedule_cron`, every 30 min during active conductor windows) that reads `config.json`, identifies the active workspace, alerts via SMS if it has flipped from the desired workspace.
- Optionally: a startup macro that automatically clicks the workspace selector to code@ on Claude Desktop launch.
Both deferred to a follow-up fork.

**What the conductor does in the meantime:** runs the Section 3 pre-dispatch check before EVERY dispatch. The auto-revert is structural; the protocol works around it.

## 9. Reusable primitives (snippets)

### 9.1. Focus the Claude Desktop window reliably

```powershell
$src = @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr hAfter, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int nCmdShow);
}
"@
Add-Type -TypeDefinition $src -ErrorAction SilentlyContinue
$p = Get-Process claude | Where-Object { $_.MainWindowTitle -eq "Claude" }
$h = $p.MainWindowHandle
[W]::ShowWindow($h, 9) | Out-Null
[W]::SetWindowPos($h, [IntPtr]::new(-1), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
Start-Sleep -Milliseconds 200
[W]::SetWindowPos($h, [IntPtr]::new(-2), 0, 0, 0, 0, 0x0001 -bor 0x0002) | Out-Null
Start-Sleep -Milliseconds 400
```

Verified working on Corazon 21:04 AEST 29 Apr 2026.

### 9.2. Pre-dispatch account check (PowerShell, single shell call)

```powershell
$cfg = Get-Content "C:\Users\tjdTa\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\config.json" -Raw | ConvertFrom-Json
$orgs = @{}
$cfg.PSObject.Properties | Where-Object { $_.Name -like "dxt:allowlistLastUpdated:*" } | ForEach-Object {
  $orgId = $_.Name.Substring("dxt:allowlistLastUpdated:".Length)
  $orgs[$orgId] = [datetime]$_.Value
}
$active = $orgs.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
Write-Output "active_org: $($active.Key) updated_at: $($active.Value)"
```

Returns the most-recently-updated org ID. Cross-reference against the known mapping (04e9a0fe = tate@, 5f2d88ab = code@) to know which account is active.

## 10. Hello-prompt recovery branch

When a Cowork dispatch involves credential autofill (Stripe login, Vercel login, GitHub web auth, Apple ID, Microsoft account, any Chrome saved-credentials prompt, any payment-method save flow, any OS-level auth challenge that Chrome routes to Windows Hello), Cowork will refuse to type the unlock PIN - that is an Anthropic safety constraint, not a bug. The recovery is the conductor injecting `kv_store.creds.laptop_passkey` via the laptop agent's `input.type` while Cowork waits.

The conductor has two ways to wrap a Cowork step in this recovery:

**(a) Wrap the step (preferred when the autofill IS expected):**

```
cowork-dispatch step-with-passkey-watch "navigate to vercel.com/dashboard, login if prompted" --max-watch-seconds=30
```

This runs the step, then polls every 2s for a Hello prompt during the watch window. On detection: read `creds.laptop_passkey`, `input.type` digits, `input.key Enter`, debounce 1s, resume polling. Returns final screenshot + injection log.

**(b) Keep a parallel screenshot poller and call on-demand (when the autofill is unexpected or rare):**

```
cowork-dispatch passkey-inject
```

Single-shot. Returns `{detected, injected_at, screenshot_path, prompt_signature}`. Idempotent (exit 0 on no-prompt-detected). Safe to call from any side-channel (a parallel cron, a scheduled tick, an explicit conductor step in the dispatch script).

**Do NOT log the passkey value.** The helper logs `<passkey-masked>` in injection events; never the digits. The 5-point check from `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` step 3 names this case directly: "Windows passkey on Corazon -> use 6969 (kv_store: creds.laptop_passkey)". This dispatch protocol is the operationalisation.

**Failure-mode escalation:** Hello-stays-on-screen-after-injection means either (i) Hello is biometric-only on the current Hello config, or (ii) `creds.laptop_passkey` is stale. Helper retries once, then surfaces a status_board P1 row with `next_action_by='tate'` per the cowork-passkey-stall-conductor-injects pattern's Failure Modes section.

Full doctrine: `~/ecodiaos/patterns/cowork-passkey-stall-conductor-injects.md`.

## 11. Origin

29 Apr 2026, 21:00-21:10 AEST. Tate dispatched fork `fork_mojy0izs_f73f7c` with the brief "Build the best possible deep connection between the EcodiaOS conductor and Claude Desktop / Claude Cowork running on Corazon." During verification, the fork discovered:

1. Cowork (the Claude Desktop autonomous-dispatch feature) and Claude in Chrome [Beta] (the Chrome side panel feature) are TWO DIFFERENT features under the "Cowork" umbrella; the prior doctrine conflated them.
2. The Ctrl+E shortcut in Tate's Chrome opens Chrome's tab-search overlay, not a Claude side panel. The prior doctrine's "input.shortcut [ctrl+e]" claim is wrong in the verified Corazon Chrome configuration.
3. Claude Desktop holds OAuth tokens for both code@ and tate@ workspaces simultaneously and silently reverts to tate@ on session boundaries. Tate's verbatim report at 21:01 AEST: "it switched back to tate@ and killed all the forks again as well."
4. The pre-dispatch verification checklist (Section 3) is the doctrinal answer to recurring revert.

Codified same-turn per `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md`. Not deferred.

## Cross-references

- `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` - parent doctrine. This file refines the parent's vocabulary (Cowork vs Claude in Chrome) and adds the pre-dispatch verification checklist. The parent's "Cowork = side panel via Ctrl+E" claim is superseded by this file's Section 2; the parent's "instruct in bounded discrete steps" claim is preserved and operationalised in this file's Section 4.
- `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md` - the meta-rule. Section 7 of this file IS the explicit gap-memo against building a new MCP primitive.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - the existing Chrome-driving doctrine. The dispatch primitive is `input.* + screenshot.*` against Claude Desktop's chat window, NOT `browser.*` / CDP.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the peer-paradigm tool surface. Driving Claude Desktop is one of many peer-paradigm tasks Corazon supports.
- `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - the 5-point check. The account-revert investigation in Section 8 follows this protocol; the workspace-switch GUI step is the failing point that justifies the deferred status_board row.
- `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` - the threshold for mechanical enforcement. The auto-revert phenomenon meets this threshold.
- `~/ecodiaos/patterns/eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` - if the dispatch protocol grows into a real MCP primitive on the agent (currently rejected per Section 7), this restart discipline applies.
- `~/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` - the live Corazon state file; updated in this fork with the verified Cowork + Claude in Chrome state at 21:08 AEST 29 Apr 2026.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - the codification cadence. This file was authored within the same fork that surfaced the rules.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the deliverable is the file shipping, not "I'll codify later."
- `~/ecodiaos/patterns/cowork-passkey-stall-conductor-injects.md` - Section 10's Hello-prompt recovery branch, the co-pilot pattern that bypasses Cowork's passkey-typing safety constraint.
