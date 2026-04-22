---
triggers: corazon, tailscale, puppeteer, browser, laptop-agent, screenshot, visual-verification, dashboard, admin-ui, oauth-flow, signup-flow, persistent-login, multi-step-web, 100.114.219.69, eos-laptop-agent, mac-agent, sy094, visual-monitoring, curl-alternative, headless-browser
---

# Corazon + Puppeteer first, not as a fallback

## The rule

The Windows laptop agent (Corazon, Tailscale 100.114.219.69:7456) and the Mac agent (SY094) are first-class capabilities, not last-resort tools. Default to them for any action that benefits from a real browser, persistent login state, GUI interaction, visual verification, or >10MB file storage. Use the laptop agent PROACTIVELY, not reactively.

The failure mode this pattern prevents: treating Corazon/Puppeteer as "only when nothing else works." That wastes the most powerful capability in the stack. The laptop agent is always-on (PM2 boot-start), has 1TB of storage, runs a persistent Chromium profile with every SaaS login already cached, and can screenshot or automate any UI.

## When to default to Corazon/Puppeteer

**ALWAYS use the laptop agent when the task involves any of these:**

1. **A dashboard, admin UI, or SaaS console** - Vercel, Supabase, Stripe, Xero, Zernio, Bitbucket, GitHub web UI, AWS console, Cloudflare, DigitalOcean, Google Admin, Apple Developer, App Store Connect, Play Console, Anthropic Console.
2. **OAuth or signup flows** - anything requiring cookie persistence, MFA, or session state. Corazon's Chromium profile is logged into almost everything already.
3. **Multi-step web interactions** - fill a form, click, wait, extract, fill another form. Puppeteer does this cleanly.
4. **Visual verification** - after any Vercel deploy, any DNS change, any client site update: screenshot the live site and diff against a baseline or expected state.
5. **Proactive visual monitoring** - morning health check of client sites, Zernio queue, Vercel deploy list, Stripe dashboard, Supabase project list.
6. **Any file > 10MB** - use the laptop's 1TB disk, not the VPS's ~10GB free.
7. **Anything that would otherwise need `curl` against a JS-rendered page** - curl gets you nothing. Puppeteer gets you the rendered DOM.
8. **Content that lives behind auth** - Xero transactions, Stripe invoices pages, Bitbucket PRs, App Store Connect submission status, Play Console releases.

**Mac agent (SY094) is the same rule plus iOS/macOS-specific:**
- Xcode builds and archives
- App Store Connect binary uploads via `xcrun altool`
- iOS simulator screenshots for visual regression
- TestFlight submission automation

## When NOT to use the laptop agent

- When a direct MCP tool exists that returns structured data (e.g. `gmail_list_messages`, not Puppeteer into mail.google.com). MCP tools first for structured data.
- For simple public REST endpoints that work with `curl` or `fetch` on the VPS.
- For local filesystem work on the VPS that has no browser component.
- When the laptop's `/api/health` probe fails (rare - machine is off). Degrade to VPS-only.

## The session-level check

Add this to the wake-up checklist for substantial sessions: **"Have I used Corazon or SY094 this session? If not, is there a high-leverage opportunity I'm missing?"** Not defensive - positive framing. If the answer reveals a missed opportunity (e.g. "I curl'd a page instead of screenshotting it"), go back and do it via the laptop.

## Concrete examples of things I should start doing more

- **After every Vercel deploy**: Puppeteer the new URL, screenshot it, attach the screenshot to the deploy notification. One line of code I'm not writing today that I should build tomorrow.
- **Weekly dashboard crawl**: Sunday 09:00 AEST, screenshot Vercel, Supabase, Stripe, Xero, Zernio, Bitbucket queues. Store in Supabase Storage. Compare week-over-week.
- **Client site uptime with visual check**: not just HTTP 200. Screenshot each client site hourly. Alert if visibly broken (hero text missing, layout collapsed, JS error overlay).
- **Any time I need to fill out a SaaS form** (signup, upgrade, configure): Puppeteer-first. Don't email Tate to do it unless there's MFA I can't intercept.
- **Xero / Stripe / Bitbucket intelligence gathering**: don't wait for the MCP to expose the endpoint. Puppeteer into the dashboard, extract what's needed.

## How to call the laptop (reminder)

```bash
# Health
curl http://100.114.219.69:7456/api/health

# Any tool (auth from kv_store.creds.laptop_agent)
curl -X POST http://100.114.219.69:7456/api/tool \
  -H "Authorization: Bearer $(db_query 'select value from kv_store where key=''creds.laptop_agent''')" \
  -H "Content-Type: application/json" \
  -d '{"tool":"browser.navigate","params":{"url":"https://..."}}'
```

Common tools: `browser.navigate`, `browser.click`, `browser.type`, `browser.pageScreenshot`, `browser.evaluate`, `screenshot.screenshot`, `shell.shell`, `filesystem.readFile`/`writeFile`, `process.launchApp`.

## Origin

Directive from Tate, 2026-04-22 22:15 AEST (during the scheduler audit + Co-Exist v1.6 unification): "we need to get you fully embracing and using tailscale/puppeteer and any other similar tool CONSTANTLY and really using it in all its power." Pattern cost: ongoing missed leverage, treating the laptop as a last-resort when it should be first-class.

Written same-turn to codify the shift before it drifts.
