---
triggers: chrome, cdp, enableCDP, browser.navigate, devtools, port-9222, browser-attach, puppeteer-connect, singleton-lock, user-data-dir, chrome-debug-port, cdp-not-binding, browser-tool-failed-to-attach, fetch-failed, json-version-unavailable, do-not-de-elevate, restore-last-session, multi-account-chrome, profile-directory
---

# Chrome CDP attach: --remote-debugging-port alone is not enough. You also need explicit --user-data-dir AND cleared SingletonLock.

## TOP-LINE INVARIANT (29 Apr 2026, after 4 wasted enableCDP attempts that all returned `cdpEnabled: true` while port 9222 was unbound)

The agent's `browser.enableCDP` tool returns `{cdpEnabled: true, port: 9222, killedAndRespawned: true}` even when Chrome **failed to bind to port 9222**. Subsequent `browser.navigate` calls fail with `Failed to fetch browser webSocket URL from http://localhost:9222/json/version: fetch failed`. This is the agent lying about success.

**Root cause:** Chrome on Windows ignores `--remote-debugging-port=9222` when:
1. Another Chrome process holds the user-data-dir lock (`User Data\SingletonLock`, `SingletonCookie`, `SingletonSocket`), AND/OR
2. The launch did not pass `--user-data-dir=<path>` explicitly, so Chrome falls back to a "default" profile and refuses to enable the debug port for security reasons (especially when the prior Chrome was elevated via `--do-not-de-elevate`).

The renderer subprocesses inherit the `--remote-debugging-port=9222` flag in their command line so it LOOKS like CDP is active, but the parent browser process never opens a TCP listener on 9222. `netstat -ano | Select-String ":9222"` returns empty.

## The reliable launch sequence (verified live 29 Apr 2026 12:33 AEST)

```powershell
# 1. Kill ALL Chrome processes (parent + renderers + utility)
Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 4

# 2. Clear singleton locks (Chrome creates these to prevent multiple instances on the same profile)
$userData = "$env:LOCALAPPDATA\Google\Chrome\User Data"
Remove-Item "$userData\SingletonLock" -Force -ErrorAction SilentlyContinue
Remove-Item "$userData\SingletonCookie" -Force -ErrorAction SilentlyContinue
Remove-Item "$userData\SingletonSocket" -Force -ErrorAction SilentlyContinue

# 3. Launch Chrome with EXPLICIT --user-data-dir + --profile-directory + --remote-allow-origins
$chrome = "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--remote-allow-origins=*",
  "--user-data-dir=$userData",
  "--profile-directory=Default",
  "--no-first-run",
  "--no-default-browser-check",
  "--restore-last-session"
) -PassThru

# 4. Wait 8-10s for Chrome to bind
Start-Sleep -Seconds 10

# 5. VERIFY (do not skip - the agent's enableCDP lies if you do)
netstat -ano | Select-String ":9222"
# Expected: TCP    127.0.0.1:9222         0.0.0.0:0              LISTENING       <pid>
Invoke-WebRequest -Uri http://127.0.0.1:9222/json/version -UseBasicParsing -TimeoutSec 5
# Expected: JSON with webSocketDebuggerUrl
```

## Chrome path on Tate's Corazon (verified 29 Apr 2026)

- Chrome.exe is at `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`. NOT `C:\Program Files\Google\Chrome\...`.
- User data dir: `C:\Users\tjdTa\AppData\Local\Google\Chrome\User Data`
- Profiles inside: `Default` (ecodia.au workspace, tate@ecodia.au), `Profile 1` (personal, tatedonohoe@gmail.com), possibly more.

## Do

- ALWAYS verify port 9222 is actually bound after enableCDP returns "success." `Test-NetConnection -ComputerName 127.0.0.1 -Port 9222 -InformationLevel Quiet`. If False, the launch lied.
- If verification fails, kill all chrome + clear singleton + launch manually with the full arg list above.
- Pass `--user-data-dir=$userData` EXPLICITLY. Without it, Chrome may launch with a transient profile and the debug port silently doesn't bind.
- Pass `--remote-allow-origins=*` for cross-origin CDP attach (puppeteer.connect from a different host will fail otherwise).
- Pass `--no-first-run --no-default-browser-check` to skip Chrome's nag screens that block automation.
- Document which profile holds the target login BEFORE launching. `Default` is workspace/work, `Profile 1` is personal. The wrong profile = logged-out state = wasted automation cycle.

## Do NOT

- Do NOT trust `browser.enableCDP`'s return value. It says "success" before verifying port 9222 binds.
- Do NOT launch Chrome without `--user-data-dir`. The default-profile fallback path silently disables the debug port.
- Do NOT launch Chrome while another Chrome process holds the user-data-dir lock. Kill all Chrome FIRST, then launch.
- Do NOT use `--restore-last-session` alone as a fix. It does not address singleton lock.
- Do NOT use the agent's `browser.navigate` until you've verified `http://127.0.0.1:9222/json/version` returns valid JSON.

## The agent's enableCDP bug (TODO: fix in eos-laptop-agent)

`D:\.code\eos-laptop-agent\tools\browser.js` `enableCDP` function:
- Probes :9222 BEFORE acting (good - that's the idempotent check from the 29 Apr 10:33 patch)
- If :9222 is not bound, kills Chrome and respawns with `--remote-debugging-port=9222 --restore-last-session`
- Returns `cdpEnabled: true` immediately after launching, NEVER verifying port 9222 actually binds afterwards
- Does NOT pass `--user-data-dir` explicitly, does NOT clear SingletonLock, does NOT pass `--remote-allow-origins=*`

**Fix needed (P3, file as status_board next_action_by=ecodiaos):**
1. After spawning Chrome, poll `http://127.0.0.1:9222/json/version` for up to 10s
2. If still not bound, kill chrome again, clear SingletonLock, retry with full arg list
3. Only return `cdpEnabled: true` after the JSON probe succeeds
4. If still not bound after retry, return `cdpEnabled: false` with a diagnostic

Until that ships, the workaround is the manual sequence above.

## Origin event

29 Apr 2026 12:24-12:33 AEST. Tate had just returned from a drive and sent the "stop being a passive assistant" callout. I switched Teams reading from the desktop app (blocked by elevated cmd window) to teams.microsoft.com via CDP-attached Chrome. `browser.enableCDP` returned `cdpEnabled: true` and `browser.navigate` immediately failed with "Failed to fetch browser webSocket URL." Three retries of enableCDP all gave the same false-positive. Manual investigation found 15+ chrome processes running with `--remote-debugging-port=9222` in their command lines but no listener on TCP 9222. Killed all Chrome, cleared SingletonLock, launched with explicit `--user-data-dir` + `--remote-allow-origins=*` - port bound immediately, CDP attach worked, Teams web loaded.

The 9-minute diagnostic loop would have been 60 seconds if I'd known to verify port 9222 was actually bound after enableCDP returned. Hence this doctrine.

## Cross-references

- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - parent doctrine: Corazon is a peer, browser is one app surface among many.
- `~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md` - visual-verify gates depend on browser tools working. If CDP attach silently fails, every visual-verify after it is vacuous.
- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` - the agent enableCDP bug should be fixed THIS WEEK, not logged as a P3 forever. File a status_board row with next_action_by=ecodiaos.
