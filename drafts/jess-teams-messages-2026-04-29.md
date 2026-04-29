# Jess Ditchfield Teams scrape - 2026-04-29

**Status: BLOCKED on architecture mismatch.**

## Discovery

Fork `fork_mojd2kpj_820970` attempted to read Jess's Teams messages via Corazon's browser per fork brief.

Probe results:
- `browser.evaluate({script: 'location.href'})` -> error: "Failed to attach to Chrome via CDP after enableCDP bootstrap. Chrome may not be in PATH, or port 9222 can not bind."
- Corazon process scan: NO `chrome` process. NO listener on `:9222`.
- Chrome IS installed at `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`, just not running.
- Running browser/Teams processes on Corazon:
  - `msedge` x5 (likely Tate's day-to-day Edge)
  - `ms-teams` x2 (Microsoft Teams **desktop app**, not browser)
  - many `msedgewebview2` (Teams desktop uses WebView2 internally)

## Conclusion

The fork brief assumed Tate had Teams open in Chrome with CDP attached on Corazon. Reality is:
1. Tate's Teams is the **native desktop client** (Electron/WebView2), not browser-based Teams.
2. Chrome on Corazon is not running, so CDP cannot attach without a fresh launch.
3. Launching fresh Chrome via `enableCDP()` would have an empty profile (no Teams sign-in) AND violates the "do not regress on patches" instruction in the brief.
4. The `~/.eos-browser` puppeteer fallback profile is also unauthenticated for Teams.

## What main thread should reconsider

To read Jess's Teams messages reliably, options are:
- **Microsoft Graph API** via app registration (requires tenant admin consent for Chat.Read).
- Ask Tate to open `teams.microsoft.com` in Edge or Chrome and authenticate, then re-run fork against that browser specifically (would need agent updates to attach to Edge via CDP, since the agent is Chrome-only currently).
- Tate manually copy-pastes the last N messages from Jess into a chat to me (cheapest path; one-shot not recurring).
- Accept that Teams is a closed channel and don't try to scrape it autonomously - rely on Tate to relay.

No messages captured. No screenshot taken (would have been of empty Chromium fallback).
