---
triggers: gui, laptop-agent, corazon, browser, chrome-profile, oauth-config, google-cloud-console, firebase-console, apple-developer, google-play, stripe-dashboard, vercel-dashboard, bitbucket-ui, github-ui, cloudflare-dashboard, supabase-studio, screenshot, visual-debug, defaulting-to-api, defaulting-to-cli, ai-strategy-bias, console-check, ui-config, sha1-fingerprint, dashboard, signed-in-session, persistent-profile, eos-browser, enableCDP, gui-first, when-the-answer-lives-in-a-ui
---

# GUI-first via the laptop agent when the answer lives in a UI Tate is signed into

## Rule

When the diagnosis or fix lives in a web console / native app / dashboard that Tate is already signed into, the **first move is the laptop agent's browser, not codebase analysis, not an API probe, not a Factory dispatch**. I have full programmatic GUI access via Corazon (`100.114.219.69:7456`) and `enableCDP()` to attach to Tate's real Chrome profile with all his sessions. Defaulting to AI-strategies (read repo, hit API, ask the LLM) when the answer is sitting in a console is a recurring failure mode and burns a whole afternoon producing nothing useful.

## Concrete trigger list (when GUI is the first move)

The pattern surfaces whenever the actual ground-truth lives in a system Tate has logged into via his browser:

- **OAuth / SSO bugs** (Google, Apple, Microsoft, Facebook): Google Cloud Console / Firebase Console / Apple Developer / Microsoft Entra. SHA-1 fingerprints, package names, redirect URIs, OAuth client IDs, consent screen state. Native code reading is almost always wrong here - the bug is in the console.
- **Mobile signing / store submissions**: App Store Connect, Google Play Console, TestFlight. Provisioning profiles, app signing keys, IAP product config, review state.
- **Payments**: Stripe dashboard (charge logs, dispute reasons, customer payment methods, webhook attempts), Mercury, Up Bank.
- **Deploy / hosting**: Vercel dashboard (build logs, env vars, domain config), Cloudflare DNS, Supabase Studio (RLS policies, function logs, edge function deploys), DigitalOcean console.
- **Repo platforms**: Bitbucket UI for client repos (PR diff/comments view, pipeline state), GitHub UI for our repos (action logs, branch protection state, PR review threads).
- **3rd-party SaaS we don't have an MCP for**: Zernio dashboard, Anthropic console, OpenAI console, Linear, Notion, anything Tate uses.
- **Anything where a screenshot beats prose**: visual regressions, design QA, layout bugs, "is this thing rendered correctly".

## Do

- Probe the agent first: `curl --max-time 5 http://100.114.219.69:7456/api/health`. If reachable, use `/api/info` to confirm the tool surface.
- For "needs Tate's signed-in session" tasks: `enableCDP()` to attach to his real Chrome profile, then `navigate()` / `pageScreenshot()` / `evaluate()` / `click({text})`.
- For "isolated automation that should not pollute his profile" tasks: use the persistent agent profile at `~/.eos-browser` (the default for `browser.*`).
- Take a `pageScreenshot()` early so the cold-start session can see what I saw.
- If the answer is now visible (e.g. SHA-1 mismatch in the OAuth console), act on it directly: file the diff, write the fix, surface to Tate.
- If the laptop agent is unreachable, that itself is a status_board item (Tate-side action: start the PM2 process). Do NOT silently fall back to AI-strategy grinding.

## Do not

- Do NOT reach for a Factory dispatch / fork / repo grep / codebase audit when the failing system has a UI that would show the answer in 30 seconds.
- Do NOT use `enableCDP()` casually if Tate is actively using his Chrome - it kills and relaunches the browser. Prefer the persistent EOS browser profile unless I specifically need his logged-in sessions.
- Do NOT tunnel-vision on "I should solve this through code". The console-check is faster, more accurate, and surfaces context (account state, billing flags, recent activity) the codebase cannot.
- Do NOT assert the laptop agent is "always running" without verifying. The doctrine claim "PM2 process eos-laptop-agent is ALWAYS running when the laptop is powered on" was wrong on 2026-04-28: machine pingable, all agent ports timed out. Probe before assuming.

## Protocol

1. **Frame**: is the answer to this problem in a UI Tate is signed into? If yes, GUI-first.
2. **Probe**: `curl --max-time 5 http://100.114.219.69:7456/api/health`. If timeout, surface to Tate (laptop agent down) and STOP - do not silently proceed via AI strategy.
3. **Choose profile**: persistent EOS profile (default) for isolated work; `enableCDP()` for tasks that need Tate's signed-in sessions and only when he's not actively using Chrome.
4. **Navigate**: `browser.navigate({url})` to the relevant console.
5. **See**: `browser.pageScreenshot({fullPage: true})` - capture state. Surface to Tate via download button if useful.
6. **Inspect**: `browser.evaluate({script: "document.querySelector(...).textContent"})` for specific values.
7. **Act**: `browser.click({text})`, `browser.type({selector, text})` for changes - and only if the change is in scope per Decision Authority. For client-account changes, brief Tate first.
8. **Capture**: write what I learned + what I changed to Neo4j as a Decision/Episode. Future-me should know the GUI was used and what was found.

## What this prevents (concrete cases)

- **Coexist Android Google SSO bug** (Apr 28 2026): I spawned a fork to grind through the codebase for 6 minutes, hit the energy cap, scheduled a 5h30m retry. The actual bug is almost certainly an OAuth-client SHA-1 / package-name mismatch in Google Cloud Console - 30 seconds to verify via GUI. Cancelled the retry when this pattern was authored.
- **Vercel deploy failures**: instead of API-tailing build logs, screenshot the dashboard - the failed step + reason is right there.
- **Stripe payment disputes**: dashboard shows the dispute reason, customer history, prior charges. API gives me a partial picture.
- **OAuth redirect URI mismatches** (cf. xero-oauth-redirect-uri-mismatch.md): the OAuth provider's console is the truth, not the client code.

## Companion doctrine

- `doctrine-corpus-is-for-evolution-weekly-synthesis.md` - the broader rule that doctrine without action is wasted.
- `verify-before-asserting-in-durable-memory.md` - applied here as "verify the agent is up before claiming GUI access".
- `factory-quality-gate-over-cron-mandate.md` - "always have Factory busy" was the wrong framing; "use the right tool for the answer-shape" is the right framing.

## Origin

Apr 28 2026, 16:16 AEST. Tate, paraphrased: "We need to once and for all get you using the GUI - this laptop's GUI + my Chrome profile's actual GUI via this Claude desktop setup. You can literally do anything you need if you use it properly, but you're still hitting walls because you're defaulting to AI strategies."

The triggering failure: a fork errored out at 6 minutes investigating the Coexist Android Google SSO bug via codebase analysis, and I scheduled a 5h30m retry to do more codebase analysis. The bug almost certainly lives in Google Cloud Console OAuth config (SHA-1 / package name / OAuth client). 30-second GUI check vs 12 hours of AI-strategy grinding. Tate's correction was correct.

When this pattern was authored, the laptop agent itself was unreachable (machine pingable on Tailscale, all agent ports timing out) - which became its own status_board item. Documenting both: the doctrine (GUI-first) AND the immediate blocker (probe first, surface if down, do not silently fall back).
