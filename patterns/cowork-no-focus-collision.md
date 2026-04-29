---
triggers: cowork-no-focus-collision, focus-collision, no-focus-collision, cowork-pre-dispatch, cowork-step-0, semi-simultaneous-work, focus-stealing, do-not-steal-focus, foreground-window-equality, foreground-app-check, cowork-coexistence, tate-active-but-different-tab, dispatch-while-tate-typing, dispatch-while-tate-active-different-window, cowork-target-collision, target-window-equality, getforegroundwindow, getwindowthreadprocessid, conductor-courtesy, win32-foreground, focus-collision-block, no-collision-proceed, cowork-target, cowork-target-app, cowork-target-tab, claude-desktop-foreground, vercel-tab-foreground, mcp-peerage-bypasses-focus-rule, v2-mcp-bypass, cowork-coexists-with-tate
---

# Cowork dispatches must not steal focus from Tate's active window

Cowork (and any `input.*` / `browser.*` operation that drives Corazon UI) **can run while Tate is actively at the keyboard**, provided the dispatch does not steal focus from Tate's current foreground window. The semi-simultaneous-work property is a real win: Cowork can drive the Vercel tab while Tate types in the EcodiaOS tab in the same Chrome instance, and they coexist. The rule is **focus-collision**, not human-idle-time.

This is **Step 0** of `~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md`. It runs BEFORE the existing 5-point checklist. The 5-point checklist verifies the substrate is ready; Step 0 verifies the dispatch will not collide with Tate's active window. A naive "don't dispatch while Tate is active" rule would destroy the semi-simultaneous-work win and is wrong.

## The probe (Win32 foreground window)

Single signal: identify Tate's active foreground window and compare it to the window Cowork is about to drive.

`GetForegroundWindow` + `GetWindowThreadProcessId` from `user32.dll`, plus a window-title and (where Chrome) tab identification probe. The conductor then computes whether Cowork's planned target is the same window/tab.

| Tate's foreground window | Cowork's target | classification | action |
|---|---|---|---|
| Chrome — Tab A | Chrome — Tab A | **collision** | defer until Tate moves OR fall back to non-focus-stealing path |
| Chrome — Tab A | Chrome — Tab B | **no collision** | proceed (semi-simultaneous-work) |
| Chrome — any tab | Claude Desktop chat | **collision** (Cowork dispatch focuses Claude Desktop) | defer until Tate moves OR fall back |
| Claude Desktop chat | Claude Desktop chat | **collision** | defer until Tate moves |
| App X | App Y (Cowork target) | **no collision** | proceed |
| Anything | OS-level screenshot only | **no collision** | proceed (capture does not steal focus) |
| Anything | `browser.*` Puppeteer (separate profile at `~/.eos-browser`) | **no collision** | proceed (Puppeteer's persistent profile is a separate Chrome process from Tate's interactive Chrome — different `--user-data-dir`, different process tree, different window) |

**Threshold framing: forget idle-time. The probe is foreground-window equality, not human-idle-time.** Tate at 03:00 AEST in his EcodiaOS chat tab is no different from Tate at 14:00 — what matters is whether Cowork's next `input.*` keystroke will land in his window or somewhere else.

## Per-tool gating

- **`screenshot.screenshot`** — OS-level capture, never steals focus. **Never gated.** Probe screenshots can run regardless of Tate's foreground state. They're how the conductor verifies the post-condition without disturbing him.
- **`input.*` operations** (keystrokes, clicks, shortcuts) — gate on focus collision. If Cowork's planned target window is Tate's current foreground, defer. If different, dispatch.
- **`browser.*` Puppeteer operations on the persistent profile** — the Puppeteer Chrome instance is separate from Tate's interactive Chrome (different profile dir at `~/.eos-browser`, different process tree). Generally safe to run while Tate uses interactive Chrome.
- **Cowork dispatch (Claude Desktop chat input)** — gate on collision with Claude Desktop foreground. If Tate is currently in the Claude Desktop chat (e.g. talking to Cowork himself), defer. Otherwise dispatch — Cowork's response renders in its own window without stealing focus from Tate's other apps.
- **MCP peerage (`api.admin.ecodia.au/api/mcp/cowork`)** — the V2 substrate per the `cowork.deep_integration.queue` Wave 2 plan does NOT touch the GUI at all. **Completely unaffected by this rule.** Cowork's MCP calls fire freely regardless of Tate's foreground state because no GUI focus is involved. When V2 ships, the focus-collision concern dissolves for any work expressible as state-write rather than UI-driving. Until then, Step 0 governs all GUI-driving paths.

## Fallback paths when collision is detected

When Step 0 returns **collision** and the work has urgency:

1. **Direct API tools.** Per `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` row 3 of the substrate-selection table — never drive a GUI for something the API exposes. Faster, no contention.
2. **VPS-only workflows.** Status board, Neo4j, kv_store, doctrine writes — all VPS-side, no Corazon involvement.
3. **Schedule a recheck.** `schedule_delayed` a Step 0 re-probe in 60–300s. If Tate moves window in that window, dispatch then.
4. **Different target window.** If the dispatch can be re-routed to a non-collision target (open a new Chrome tab and drive that), do so.
5. **Cowork via V2 MCP peerage** — when Wave 2 ships per the `cowork.deep_integration.queue`, the canonical bypass is to express the work as a Cowork MCP call (status_board upsert, Neo4j write, fork spawn) rather than a GUI dispatch. Once W2-B implements that surface, MCP peerage is the canonical bypass for any focus-collision concern — collision becomes a non-issue rather than a deferred dispatch.

Do NOT fall back to a second `browser.*` Chrome process pointing at Tate's logged-in profile (`--user-data-dir=Default`) — that's the failure mode `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` catalogues. The Puppeteer fallback uses `~/.eos-browser`, NOT Tate's profile.

## Why `SetForegroundWindow` and `AppActivate` returning True is not enough

Origin event detail: the conductor called `SetForegroundWindow` against the Claude Desktop HWND (returned True) AND `WScript.Shell.AppActivate` against title "Claude" (also returned True), but Chrome retained foreground. Windows blocks programmatic focus-stealing when another process has received user input recently. The OS API returns success because the *request* was honoured, but the actual focus state is unchanged.

Success-return from focus-API calls is NOT verification that focus actually moved. The only verification is a screenshot comparison BEFORE and AFTER the focus call, and even that is racy if Tate continues typing. Step 0 prevents the race entirely by checking whether the planned `input.*` target collides with Tate's foreground BEFORE any focus call is attempted — if collision, no focus call, no race.

## Implementation hint

PowerShell wrapper that the laptop agent can run via `shell.shell`, returning Tate's current foreground window identity:

```powershell
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FgWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [FgWin]::GetForegroundWindow()
$pid = 0; [void][FgWin]::GetWindowThreadProcessId($h, [ref]$pid)
$sb = New-Object System.Text.StringBuilder 512
[void][FgWin]::GetWindowText($h, $sb, 512)
$proc = Get-Process -Id $pid -ErrorAction SilentlyContinue
@{ pid = $pid; process_name = $proc.ProcessName; window_title = $sb.ToString() } | ConvertTo-Json
```

The conductor calls this once at dispatch-prep, snapshots `{process_name, window_title}`, and computes collision against the planned target. For Chrome-tab-level granularity (Tab A vs Tab B in the same Chrome process), the conductor reads the window title — Chrome surfaces the active tab title in the window title — OR uses `browser.evaluate` against the puppeteer connection if that's already attached.

This belongs as a `foreground-check` subcommand of `~/ecodiaos/scripts/cowork-dispatch` (the Wave 1 helper script). The helper script was authored by fork_moklri02_7821cd on 30 Apr 2026 and was on disk at 10251 bytes when this synthesis fork's first verify probe ran, but was wiped along with all other untracked work by a sibling fork's `git clean` mid-synthesis-turn — the helper needs re-authoring AND first-commit AND the `foreground-check` subcommand in a single Wave 1.5 fork. See `~/ecodiaos/patterns/sdk-forks-must-commit-deliverables-not-leave-untracked.md` for why this destruction happened and how to prevent it next time.

## Do

- Run Step 0 BEFORE the existing 5-point pre-dispatch checklist on every Cowork / `input.*` / `browser.*` operation that drives Corazon UI.
- Treat `SetForegroundWindow` / `AppActivate` returning True as a request acknowledgement, NOT proof of focus.
- Compare Tate's foreground window identity against Cowork's planned target. If different — proceed. If same — defer or fall back.
- Always allow `screenshot.screenshot` regardless of Tate's foreground state — it does not steal focus.
- Always allow MCP peerage calls (V2, when shipped) regardless of focus state — they do not touch the GUI.
- Stamp every deferred dispatch with the conductor fork id + the foreground-window identity that triggered the defer, so post-hoc telemetry can validate the rule.

## Do NOT

- Do not gate on idle-time. Tate at 03:00 AEST in his EcodiaOS chat is no different from Tate at 14:00 — what matters is whether Cowork's next keystroke lands in his window or somewhere else.
- Do not block all dispatches "because Tate is active." That destroys the semi-simultaneous-work win — Cowork can drive the Vercel tab while Tate types in the EcodiaOS tab and they coexist.
- Do not skip Step 0 just because the 5-point check passed. Substrate-ready ≠ no focus collision.
- Do not fall back to `browser.*` with `--user-data-dir=Default` — that opens a SECOND Chrome on Tate's profile and clears his SingletonLock. The Puppeteer fallback uses `~/.eos-browser`, separate process and profile.
- Do not assume "Tate moved focus 2 seconds ago, we're fine" — re-probe foreground at the moment of dispatch, not before the bounded-step loop started.

## Origin

30 April 2026, 08:16 AEST, Tate verbatim refining fork_moklpzze_7ba406's earlier insight from 08:08 AEST: "Cowork can use my laptop GUI without affecting my workflow for the most part. It can definitely use Chrome without me having to leave the computer alone while it works, that's awesome, and it can probably do the same for other things so we can work semi-simultaneously."

The originating fork (fork_moklpzze_7ba406, end-to-end Cowork verification) deferred a dispatch step at 08:08 AEST because Tate was actively using Chrome on Corazon. The fork's status_board write classified the failure mode as `human_contention` and recommended a Step 0 invariant. The synthesis fork (fork_mokm4yba_a1c59a, this fork) initially codified the rule as idle-threshold gating ("Tate active = defer all"). Tate corrected mid-turn: the rule is focus-collision, not human-active. The semi-simultaneous-work property is the win this rule preserves; the naive idle-time framing would have destroyed it.

This pattern file replaces an earlier draft `cowork-pre-dispatch-detect-active-human-input.md` (deleted in the same fork) which had the wrong framing. The pattern file was authored once, wiped by a concurrent sibling fork's destructive git operation against the working tree, and re-authored — see `~/ecodiaos/patterns/sdk-forks-must-commit-deliverables-not-leave-untracked.md` for the discipline that emerged from the wipe event.

## Cross-references

- `~/ecodiaos/patterns/cowork-conductor-dispatch-protocol.md` — Step 0 is now part of this protocol's pre-dispatch checklist. This pattern file is the detail; the protocol file references it.
- `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md` — the parent doctrine; Step 0 protects the substrate from a courtesy failure that would otherwise cost trust.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` — the same focus-collision reasoning applies to direct `input.*` Chrome-driving, not just Cowork.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` — peer-paradigm framing; even peer-tools must respect target-window collision on the peer machine.
- `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` — why `browser.*` against Tate's profile is NOT a valid fallback when Step 0 returns collision; the Puppeteer fallback uses `~/.eos-browser` instead.
- `~/ecodiaos/patterns/verify-deployed-state-against-narrated-state.md` — the meta-rule applied during this pattern's authoring (twice — once for the original Wave 1 deliverables whose state-store narration ran ahead of git-commit reality, once for the synthesis fork's own initial bad-glob verify probe).
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` — the codification-discipline rule that drove this file's existence; the originating fork stated the rule in a status_board write without authoring the pattern, and synthesis caught the gap.
- `~/ecodiaos/patterns/sdk-forks-must-commit-deliverables-not-leave-untracked.md` — sibling pattern authored in the same synthesis turn; explains why uncommitted-on-disk is a transient lifecycle stage, and why the Wave 1 helper-script + drafts were destroyed mid-synthesis.
- `~/ecodiaos/clients/corazon-peer-architecture-2026-04-29.md` — live machine state including the foreground-app-blocking-focus phenomenon noted under Cowork dispatch state.
- `kv_store.cowork.deep_integration.queue` Wave 2 plan — the V2 MCP peerage substrate (W2-A spec → W2-B implementation) is the canonical bypass for any focus-collision concern.

Authored: 30 April 2026, fork_mokm4yba_a1c59a (Cowork buildout Wave 1 synthesis), per Tate's 08:16 AEST refinement. Re-authored after a concurrent sibling fork's `git clean` wiped the first authoring along with all other untracked working-tree state.
