---
triggers: drive-chrome-via-input, browser.*, browser.navigate, browser.enableCDP, input.click, input.type, input.shortcut, taskbar-click, click-chrome-icon, native-gui-automation, port-9222, default-profile, tate-chrome, no-spawn-chrome, no-kill-chrome, just-click-the-icon, gui-first-chrome, drive-chrome, open-chrome, win-1, super-key, ctrl-l, address-bar, no-puppeteer-default
---

# Drive Tate's existing Chrome via input + screenshot tools, NOT via browser.* / CDP / spawn

## Rule

**On Tate's laptop, drive his existing Chrome via `input.*` + `screenshot.*` tools, NOT via `browser.*` / CDP / spawn. Open Chrome the same way Tate does: click the taskbar icon (`input.click`), use `input.shortcut` Win+1/2/etc, or `input.key` super to open Start + type "chrome" + enter. Then drive it via `input.shortcut [ctrl, l]` for the address bar, `input.type` for URLs, `input.click` for buttons, `screenshot.screenshot` to read state. The `browser.*` toolset is reserved for the rare case where CDP attachment to an already-running Chrome on port 9222 is genuinely needed and Tate has manually launched Chrome with that flag. The DEFAULT is native GUI automation on the Chrome Tate already uses.**

## Why

Tate opens Chrome by clicking the taskbar icon. That is the canonical user action on his machine. The agent should match that behaviour exactly.

Spawning Chrome via `puppeteer.launch` / `browser.enableCDP` / `shell.shell chrome.exe --remote-debugging-port=9222` does the opposite. It launches an isolated profile (`.eos-cdp-profile`, or whatever directory the wrapper picks) with no logins, no saved passwords, no Vercel / Apple / GitHub / Stripe / Microsoft session cookies. Even with explicit `--user-data-dir` + `--profile-directory=Default` flags, Session 0 (the PM2 daemon's session on Windows) launching Chrome cannot bind port 9222 reliably due to Windows session isolation between Session 0 services and Tate's interactive Session 1 desktop.

The simpler, more reliable answer is to treat Chrome the way Tate does: click the icon, drive via `input.*`. There is nothing about driving a logged-in browser that requires CDP. Address bar exists, links are clickable, screenshots are readable. The browser does not know it is being automated.

## Protocol

1. **To open Chrome:** `input.click` on the Chrome taskbar icon (locate exact `{x, y}` first via `screenshot.screenshot`) OR `input.shortcut [super]` to open Start, then `input.type "chrome"`, then `input.key enter`. On Windows, `input.shortcut [win, 1]` (or whichever index Chrome occupies) is also valid if Tate's taskbar order is known.
2. **To navigate:** `input.shortcut [ctrl, l]` to focus the address bar, `input.type "<url>"`, `input.key enter`.
3. **To click links / buttons:** `screenshot.screenshot` to see the page, locate the target, then `input.click {x, y}` on the visible coordinates.
4. **To type into forms:** `input.click` on the field (located via screenshot), then `input.type "<text>"`. For passwords, `input.type` works the same way; the page does not see a difference between typed and pasted input from `input.*`.
5. **To verify state:** `screenshot.screenshot`. The image is the source of truth for what Tate sees.
6. **To switch tabs:** `input.shortcut [ctrl, tab]` (next), `input.shortcut [ctrl, shift, tab]` (prev), or `input.shortcut [ctrl, <n>]` for the nth tab.
7. **To close a tab:** `input.shortcut [ctrl, w]`.
8. **To open a new tab:** `input.shortcut [ctrl, t]`.
9. **NEVER** use `browser.enableCDP`, `browser.navigate`, `browser.click`, `browser.evaluate`, `browser.pageScreenshot`, etc. unless Tate has manually launched Chrome with `--remote-debugging-port=9222` in his interactive Session 1 AND has explicitly approved CDP attachment for the task.

## Do NOT

- Do NOT call `browser.enableCDP`. The agent's enableCDP path post-29-Apr-1428-patch returns clean errors and never spawns, but the rule is: don't reach for `browser.*` in the first place.
- Do NOT call `shell.shell` with `chrome.exe` + `--remote-debugging-port`. That bypasses the rule.
- Do NOT use `puppeteer.launch` (the agent has no path that does this anymore, but if you write new code, do not add it).
- Do NOT spawn a separate Chromium process. Use Tate's Chrome.
- Do NOT clear `SingletonLock` files. They are Tate's Chrome's lock.
- Do NOT call `taskkill /F /IM chrome.exe`. Ever. That is Tate's open Chrome with his open tabs.
- Do NOT attempt to "just briefly" launch a parallel Chrome with a different profile to "verify a thing". That is the same failure mode in a smaller package.

## Exception (rare)

The ONLY case where `browser.*` is acceptable: when Tate has already launched Chrome with `--remote-debugging-port=9222` manually in his session AND the task requires CDP-specific capability that `input` + `screenshot` cannot achieve, such as:
- DOM inspection beyond what a screenshot can show (e.g. invisible attribute extraction)
- Page-level `evaluate` (running JS in the page context)
- Network interception (request / response inspection)

In that case `browser.enableCDP` returns `alreadyRunning: true` and `browser.*` tools attach via `puppeteer.connect` to the existing Chrome. This is rare. The default is GUI-first.

If the task seems to need CDP, first ask: can `screenshot.screenshot` read the data? Can `input.shortcut [ctrl, shift, j]` open DevTools and `input.*` drive it? Almost always yes.

## Cross-references

- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - parent doctrine. The peer paradigm: Corazon is a Windows host with full input + filesystem + shell, not a browser-via-HTTP wrapper.
- `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - drives the rule about exhausting the laptop route before classifying anything as Tate-blocked. The 5-point check's step 2 ("is the credential in Tate's Chrome Default profile?") should now use `input.*` + `screenshot` rather than `browser.enableCDP` + `browser.navigate`.
- `~/ecodiaos/patterns/chrome-cdp-attach-requires-explicit-user-data-dir-and-singleton-clear.md` - this becomes a niche pattern for the rare CDP-required case described in the Exception section above. Default does not use it.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - this pattern was authored same-turn rather than promised "for later". Symbolic-logging banned.

## Origin

29 Apr 2026, 14:32 AEST. Tate verbatim:

> "What... I just open chrome by clicking on it... that's what you should be doing, not this bullshit new browser stuff."

Authored same turn (no symbolic-logging). Today's session showed the failure pattern repeatedly: 4+ Chrome-kill incidents (the `enableCDP` path was killing Tate's running Chrome), 2 isolated-profile spawns (returning logged-out state on apps Tate is logged into), 1 Tate-flagged confidence drop. The `browser.*` path failed 100% of the time today. The `input.click` + `screenshot.screenshot` path worked the only time it was tried (clicked Jess's Teams chat at 12:21 AEST, read it cleanly).

The conclusion: the agent had been routing every Chrome-touching task through `browser.*` because that is the named "Chrome tool". But the simpler, native, less-flaky path is `input.*` + `screenshot.*`. That is what Tate does, and that is what works.

Authored fork: `fork_mojk86cx_a6e102`.
