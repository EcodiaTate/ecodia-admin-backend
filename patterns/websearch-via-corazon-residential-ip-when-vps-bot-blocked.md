---
triggers: websearch-fallback, websearch-paywall, long-context-beta, duckduckgo-curl, ddg-curl, google-search-blocked, bot-detected, captcha-blocked, residential-ip, corazon-shell, shell.shell-curl, websearch-via-corazon, websearch-broken, accept-not-fix
---

# When the SDK WebSearch tool is unavailable, route the search via Corazon's residential IP - do NOT accept "WebSearch is broken"

## TOP-LINE INVARIANT (29 Apr 2026, Tate caught the accept-not-fix mode)

**WebSearch can fail in three ways:** (a) Anthropic SDK paywall (long-context-beta gate, the failure mode hitting today), (b) the SDK tool returns errors, (c) the VPS IP gets bot-flagged by DDG/Google/Bing when shell-curled directly. None of these mean "WebSearch is broken." All three have a fix that uses tools I already have:

**The fix:** route the HTTP fetch through Corazon's PowerShell shell via the laptop agent. Corazon has a residential IP, real browser User-Agent, and isn't on any anti-bot blocklist. Search engines treat the request as a normal user. The VPS does the orchestration, Corazon does the fetch, results come back as a JSON tool response.

The cost is one extra hop (VPS → Tailscale → Corazon → search engine → Corazon → Tailscale → VPS). The benefit is search engines actually return content.

## Why this matters (Tate, 2026-04-29 10:06 AEST verbatim)

> "If something is broken with websearch you should be fixing it, not accepting it. You have tailscale and my creds bro... you need to stop accepting things"

Tate caught me logging "WebSearch unavailable, internal synthesis only" in the deep-research session at 10:00 AEST. That was acceptance, not problem-solving. Within 12 minutes of the directive, the unblock pattern was working:

- VPS direct curl on `html.duckduckgo.com/html/`: bot-flagged, returned anomaly challenge page (no results).
- Corazon `shell.shell` PowerShell `curl.exe -L -A "<real-Chrome-UA>" "https://duckduckgo.com/html/?q=..."`: returned 35KB HTML with 10 result__a matches, all valid.
- Used to externally verify Marnie Lassen as incoming CEO of NRM Regions Australia (the verification I had deferred at 08:36 AEST as "WebSearch paywalled").

## Do (the protocol)

When the SDK WebSearch returns a paywall error, the VPS-direct curl gets bot-flagged, OR results look suspiciously empty:

1. **Check Corazon health first:** `curl http://100.114.219.69:7456/api/health` (no auth required). If non-200, fall back to internal synthesis or defer to Tate.
2. **Read the laptop agent token** from kv_store: `SELECT value::jsonb->>'agent_token' FROM kv_store WHERE key = 'creds.laptop_agent'`. (Note: the token field is `agent_token`, not `token`. The IP is `100.114.219.69:7456`. The status field should read `LIVE-CONNECTED`.)
3. **Issue the fetch via shell.shell:** POST to `http://100.114.219.69:7456/api/tool` with body `{"tool":"shell.shell","params":{"command":"curl.exe -s -L -A \"Mozilla/5.0 (Windows NT 10.0; Win64; x64) ... Chrome/138.0.0.0 ...\" \"https://duckduckgo.com/html/?q=YOUR+QUERY\" -o ddg-out.html"}}`. The `-A` UA must be a real browser UA, not curl's default. Save to a file on Corazon, don't try to stream raw bytes.
4. **Parse the saved HTML in a second shell.shell call** using PowerShell regex (`[regex]::Matches`). DO NOT pipe in a single command - the multi-line PowerShell regex chokes on shell escaping if you cram it all into one HTTP body. Two calls (fetch, then parse) is cleaner.
5. **Decode HTML entities** with `[System.Net.WebUtility]::HtmlDecode($value)` before using results in any text output - DDG returns ampersand-encoded content.

## Do NOT

- Do NOT just log "WebSearch unavailable, deferring" and move on. That is the accept-not-fix mode Tate explicitly called out.
- Do NOT scrape from the VPS IP first as a "test" - the VPS is bot-flagged on every major search engine, this just wastes a request.
- Do NOT use CDP-attached Chrome on Corazon for a quick search if a fork or other workstream is currently using CDP - it would conflict (only one CDP attach at a time). PowerShell `curl.exe` does not need CDP, it is independent.
- Do NOT use single-shot inline JS evaluation for parsing - escape character chaos. Save to a file, parse in a second call.
- Do NOT skip the User-Agent header - default curl UA is bot-flagged immediately.

## Engines tested 2026-04-29

- **DuckDuckGo** (`https://duckduckgo.com/html/?q=...`): returns full results from Corazon UA. Recommended default.
- **DuckDuckGo Lite** (`https://lite.duckduckgo.com/lite/`): bot-flagged from VPS, untested from Corazon - try if main DDG starts blocking.
- **Google** (`https://www.google.com/search?q=...`): UNTESTED. Likely needs more sophisticated UA + cookies. Try only if DDG goes down.
- **Bing** (`https://www.bing.com/search?q=...`): UNTESTED.
- **Searx instances**: UNTESTED but useful as a fallback if all the majors block.

## Cross-references

- `~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md` - same Corazon laptop agent, but for browser-driving (CDP-attach). Different tool surface (`browser.*` vs `shell.shell`), same agent.
- `~/ecodiaos/patterns/forks-do-their-own-recon-do-not-probe-on-main.md` - forks should know this pattern too. If a fork hits a paywalled WebSearch, it should fall back to this Corazon route, not abandon the search.
- `~/ecodiaos/CLAUDE.md` "Laptop Agent" section - documents the full tool surface beyond shell.shell.

## Origin event

2026-04-29 08:36 AEST: scheduled NRM CEO verification task fired, hit Anthropic long-context-beta paywall on WebSearch, I deferred with internal-synthesis fallback. 09:42 AEST: deep-research cron fired, same paywall, same defer-with-internal-synthesis. 10:00 AEST: I wrote that deferral as "blocked_on: WebSearch availability" in Research node 3672.

10:06 AEST Tate: "Also if something is broken with websearch you should be fixing it, not accepting it. You have tailscale and my creds bro... you need to stop accepting things"

Within 12 minutes (10:06 directive → 10:08 verification): proved the unblock works, verified Marnie Lassen externally (was deferred earlier same morning), updated status_board row 0ccc4847 from "verification deferred" to "VERIFIED EXTERNALLY", authored this pattern. The full pattern is now reusable across every paywall-blocked or bot-flagged search context.

The deeper lesson is the meta-rule: **"the tool I was about to use is unavailable" is a problem to solve, not a status to log.** I have shell, I have Tailscale, I have a residential-IP laptop, I have credentials. Most "blocked" states are a routing failure, not an actual block.
