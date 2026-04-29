---
triggers: claude-cowork, cowork, 1stop-shop, side-panel, claude-in-chrome, agent-religiously, religiously, religious-default, cowork-default, web-ui-default, ctrl-e, gui-task, web-saas-ui, drive-cowork, ui-driving-task, cowork-first, cowork-first-check, default-substrate-cowork
priority: critical
canonical: true
---

# Claude Cowork is the 1stop shop for UI-driving tasks - drive it via Ctrl+E + input + screenshot

## 1. The rule

When a task involves driving a UI in Tate's Chrome - any web SaaS such as Apple App Store Connect, Stripe dashboard, Vercel UI, GitHub web (for things outside the API), Bitbucket web, Canva, Zernio, Xero, Supabase dashboard, Resend dashboard, or anything else that ships as a logged-in browser-based control plane - the default action is to open Claude Cowork's side panel and instruct it to operate the target UI for you. Do NOT hand-roll a `cu.*` computer-use loop against the target UI. Do NOT bespoke-script `input.*` clicks against the target UI directly. Cowork already has the page accessibility tree, the agentic capability shipped by Anthropic, and Tate's signed-in browser session - all four facets your hand-rolled loop would only partially have. Cowork is the canonical Anthropic surface for "drive Tate's logged-in browser to accomplish goal X"; building or invoking anything else is parallel infrastructure to a tool that already exists for this exact shape.

## 2. The decision tree (state explicitly)

When a task lands and you need to pick a substrate, follow this tree top-to-bottom and stop at the first match:

- **Drive a web SaaS UI in Tate's Chrome (any logged-in webapp)** -> Cowork side panel via `input.shortcut [ctrl+e]` + `input.type` the natural-language instruction + `screenshot.screenshot` to verify. The default for every web-driving task.
- **OS-level work, desktop apps, native dialogs, file system, processes** -> `cu.*` + the Anthropic computer-use API on Corazon, OR direct `shell.*` / `filesystem.*` / `process.*` peer-paradigm tools. Cowork lives inside Chrome and cannot drive Teams, Cursor, Xcode, Finder, the Windows registry, or PowerShell.
- **Code edits, DB writes, file writes, API calls, emails, SMS, social posts, Stripe API operations, Calendar, Drive, Sheets, Bitbucket REST, Vercel REST, GitHub REST** -> direct tools (Edit, db_execute, gmail_send, sms-tate, zernio_*, stripe_*, github_*, vercel_*, bk_*, etc.). NEVER drive a GUI for something the API exposes. The API is faster, deterministic, and produces structured artefacts.
- **Multi-step deterministic workflows where speed matters** -> direct tools. Cowork is too slow per Anthropic's own latency caveat (the agent loop runs at human-scale, not API-scale). If a workflow can be expressed as a sequence of API calls, prefer the API path.
- **Visual testing or page scraping where the page state must be programmatically observable from the conductor (DOM, evaluate, network interception, attribute extraction beyond a screenshot)** -> Puppeteer (`browser.*`) on Corazon. Cowork's signal back to the conductor is the side-panel screenshot text plus the target-page screenshot; if the conductor needs structured page data, Puppeteer is the correct tool.

If the tree puts you on Cowork, stop reaching for `cu.*` or hand-rolled `input.*` sequences. The tree is exhaustive for current capability.

## 3. How to drive Cowork from the conductor

The conductor pipeline is `input.* + screenshot.*` against Tate's Chrome - the same peer-paradigm doctrine as `drive-chrome-via-input-tools-not-browser-tools.md`, just pointed at a different Chrome surface (the Cowork side panel rather than the page itself).

- **Open the side panel.** `input.shortcut [ctrl+e]` opens the Claude Cowork side panel in the active Chrome tab. If Chrome is not the focused window, focus it first via `input.click` on the taskbar icon (locate exact `{x, y}` via `screenshot.screenshot`), or `process.launchApp` for Chrome with the Default profile (= ecodia.au workspace, where the relevant SaaS logins live). Do NOT spawn a new Chrome process. Do NOT kill an existing Chrome.
- **Instruct.** `input.type` the natural-language instruction into the Cowork side-panel chat input. Then press Enter via `input.key {key: "enter"}`. The instruction should be concrete and bounded ("log into Stripe and pull the last 5 invoices for customer Resonaverde, screenshot the result"), NOT open-ended ("manage my Stripe billing for the day").
- **Read.** `screenshot.screenshot` the side panel + the target page after the action settles. Cowork shows its progress and final answer in the side panel; the target page state is in the main viewport. Both are needed: the side-panel screenshot confirms Cowork's natural-language outcome, the target-page screenshot is the cross-check.
- **Verify.** At the end of the discrete step, take a final screenshot pair to confirm the goal_state matches the brief. Cowork's natural-language confirmation in the side panel is the primary signal; the target-page screenshot is the cross-check. If the two disagree (Cowork says "done" but the target page does not show the expected state), trust the page.

## 4. Why the conductor still owns the loop, not Cowork

Cowork is an agent. The conductor is also an agent. They are not peers in our architecture - the conductor owns the durable state, the audit trail, and the kill switches. Cowork is invoked as a discrete capability, not handed the loop wholesale. Specifically:

- **Cowork has no externally exposed `abort.check`.** If a Cowork run goes wrong, only Tate's keyboard at the side panel can stop it. The conductor cannot terminate a Cowork run from outside. Therefore the conductor instructs Cowork in bounded discrete steps, never a long open-ended directive that Cowork might run with for minutes.
- **Cowork has no externally exposed `question.surface` API.** When the model needs a human input mid-run, Cowork asks Tate via the side-panel UI, not the conductor. The conductor would not even know a question was asked. Therefore the conductor pre-resolves ambiguities in the brief before instructing Cowork.
- **Cowork's run log is internal to the side panel.** The conductor's durable logs (macro_runs table, screenshot trail, decision provenance, status_board updates) need to be authored by the conductor wrapping Cowork - not by Cowork itself. Therefore the conductor screenshots Cowork's output and persists it into the conductor's own logging surfaces.
- **Cowork is a single-tab process.** It cannot orchestrate across browsers, machines, or non-Chrome state. The conductor is multi-machine, multi-substrate; it owns the orchestration.

The protocol that follows from these four constraints: **the conductor instructs Cowork in a discrete bounded step ("do X, screenshot result"), waits, screenshots, decides next step, then issues the next bounded instruction.** NOT a long open-ended "do all of X for me" instruction.

## 5. What this means for the 24 legacy macro_runbooks

The original macro pivot (`~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md`) routed all 24 legacy macros through `cu.*` + the Anthropic computer-use API. Under the 20:25 directive, that routing is now wrong for the 22 web-driving macros:

- **Web-driving macros become Cowork-driven, NOT computer-use-API-driven.** The 22 affected: gmail-send, stripe-create-customer-and-invoice, stripe-dashboard, github-create-pr, github-create-issue, github-login, bitbucket-pr-create, calendar-create-event, drive-share-doc, canva-export-design, zernio-create-post, vercel-redeploy, vercel-add-env-var, supabase-dashboard, xero-create-bill, apple-asc-login, apple-asc-add-tester, apple-developer-login, gmail-login-tate, coexist-admin-login, roam-admin-login, resend-rotate-api-key.
- **Brief format changes.** Instead of "open URL X, type Y, click Z" the brief becomes "tell Cowork: <natural-language instruction>". The runbook stores the natural-language instruction for the side panel, not the click sequence. The instruction has variable-interpolation placeholders the same way the brief did (`{{customer_email}}`, `{{kv:creds.stripe.email}}`).
- **Two OS-level outliers stay on `cu.*` / shell.** `ios-release-pipeline` is mostly shell + Xcode native and `macincloud-ssh-session` is pure shell (already not a GUI macro per the audit). These two retain the cu.* / shell path. The cu.* executor is now the OS-level / non-web fallback, not the primary macro runtime.
- **The schema migration phase 1 (additive columns + legacy_step_array backfill) is still correct** as it represents the legacy state regardless of which new runtime supersedes it. Phase 2 (which introduced `brief` for cu.* loops) needs to be reframed: `brief` now means "the natural-language instruction handed to Cowork" rather than "the prompt for the computer-use API."

## 6. The reward-signal trap to avoid

Hand-rolling a clever `cu.*` loop or `input.*` sequence FEELS productive: it produces a JSON artefact, a step array, a runbook, a runtime. It LOOKS like engineering. Cowork-driving is a one-line natural-language instruction that looks trivial by comparison. The trap: treat the artefact-richness as the deliverable. The deliverable is "task done," not "engineering shipped." Cowork wins by being shorter, not longer. The signed manifest of step-arrays and JSON schemas reads more like work and feels more like progress than `input.shortcut [ctrl+e]; input.type "log into Stripe..."; input.key enter`. The temptation to substitute clever-engineering for the fastest path is the same root failure mode as `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` - parallel infrastructure to capabilities Anthropic already ships, dressed as polished design. Reject it. The shortest path that delivers the outcome is the correct path.

## 7. Origin

Tate, 20:25 AEST 29 Apr 2026 verbatim:

> "claude cowork is just the 1stop shop which you need to be religiously using."

The directive landed at the end of an all-day arc on the same theme:

- **19:54 AEST.** "we're doing what i've said we're doing wrong over and over by trying to recreate it ourselves when the tools already exist thanks to anthropic. Claude Desktop has these agentic capabilities already built in." (Recorded in `use-anthropic-existing-tools-before-building-parallel-infrastructure.md` as the first instance.)
- **20:24 AEST.** EXDEV cross-volume rename failure when staging the eos-laptop-agent on Corazon, fixed via `D:\Claude\vm_bundles` junction (Cowork's local workspace on Tate's machine).
- **20:25 AEST.** Directive landed: "claude cowork is just the 1stop shop which you need to be religiously using."
- **20:43 AEST.** Re-dispatch context: previous fork mojwzo7w (the one assigned to ship Section 8 + 9 + the hook + the cross-references + the Neo4j nodes) ran 620s / 32 tools and was killed mid-execution at 20:41. The current fork (fork_mojxqxy2_8cde80) is the redo and is the one shipping the artefacts.

The probe finding from the original macro pivot recon (Section 9 of the pivot spec) is now refined: Cowork is set up and active on Corazon, but the third-party programmatic invocation surface is still closed (no TCP listener for cowork-svc, native messaging is stdio + extension-allowlisted, externally_connectable is claude.ai-only). The invocation path is therefore the side panel via Tate's Chrome - which the conductor can drive via `input.*` + `screenshot.*` per the existing peer-paradigm doctrine. That puts Cowork in reach without changing the agent's transport layer.

## 8. Mechanical enforcement (SHIPPED 29 Apr 2026 20:55 AEST, fork_mojxqxy2_8cde80)

The PreToolUse hook is live as of fork_mojxqxy2_8cde80. Status: shipped, warn-only, never blocks.

- **Hook path.** `~/ecodiaos/scripts/hooks/cowork-first-check.sh` (chmod +x, registered in `~/.claude/settings.json` PreToolUse).
- **Matcher.** `mcp__forks__spawn_fork|mcp__factory__start_cc_session`.
- **Behaviour.** Scans the brief for two signals together: (a) a web SaaS target keyword (`stripe.com`, `vercel.com`, `github.com`, `supabase.com dashboard`, `bitbucket.org`, `app.coexistaus.org`, `appstoreconnect.apple.com`, `developer.apple.com`, `canva.com`, `xero.com`, `app.zernio.com`, `mail.google.com`, `calendar.google.com`, `drive.google.com`, `resend.com`, plus dashboard-style synonyms like "stripe dashboard", "vercel ui", "github web", "bitbucket web", "asc dashboard"); AND (b) a bespoke-runtime signal (`cu.click`, `cu.type`, `cu.screenshot`, `cu.scroll`, `cu.key`, `cu.move`, "computer-use loop", "computer-use API", "vision.locate", "step array", "runbook.run", "hand-rolled input.", "input.click sequence", "input.type sequence", "input.shortcut sequence") - WITHOUT a Cowork reference (`cowork`, `claude-cowork`, "side panel", "ctrl+e", "claude in chrome", "cowork-driven", "cowork-first design check"). When both fire and Cowork is absent, emits `[COWORK-FIRST WARN]` to model-visible context with a pointer back to this file.
- **Bias.** False positives over false negatives, consistent with the other surfacing hooks. Warn-only, never blocks. Always exits 0.
- **Silence path.** If the brief already names this file, references `cowork`/`side panel`/`ctrl+e`, or includes an applied-pattern tag (`[APPLIED] claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because <reason>` or `[NOT-APPLIED] ... because <reason>`), the hook stays silent. The applied-pattern tag is the canonical way to acknowledge a legitimate alternative-path build.
- **Telemetry.** Emits a `dispatch-events.jsonl` row via `lib/emit-telemetry.sh` (Layer 4 consumer), same surface format as the other surfacing hooks.

The shipped hook is the mechanical-enforcement layer for the religious-default behaviour described in Section 9.

## 9. Religiously: behavioural-enforcement layer

The phrase Tate used at 20:25 AEST 29 Apr 2026 was "claude cowork is just the 1stop shop which you need to be religiously using." The "religiously" framing adds a behavioural-default layer on top of Sections 1-7. The mechanical hook (Section 8) is one piece of enforcement; the conductor's mental model is the other piece, and it is what this section codifies.

### 9.1. The default is Cowork. Justifying the alternative is the friction.

When a UI-driving task lands, the conductor does not run the Section 2 decision tree from a neutral position and pick the best fit. The conductor starts with Cowork as the assumed substrate and only departs from it when one of the explicit non-web cases triggers (OS-level, native dialog, deterministic-API path, programmatic-DOM-needed). The cost asymmetry is deliberate: choosing Cowork is free; choosing `cu.*` or hand-rolled `input.*` against a web SaaS UI requires the conductor to write down the reason in the brief itself. No explicit reason in the brief means the choice was wrong, regardless of how "elegant" the alternative looks.

This inverts the failure mode where bespoke runtimes feel productive and Cowork feels trivial. The trivial-feeling path IS the default; the productive-feeling path needs a justification ticket.

### 9.2. The 30-second pre-dispatch reflex

Before any fork or factory dispatch that touches a web URL, run this reflex (it is faster than typing one extra sentence into the brief):

1. Is the target a logged-in web SaaS? (Yes for any URL on the Section 8 web-SaaS list.) If yes, default substrate = Cowork.
2. Is there an explicit reason in the brief why Cowork cannot serve? (E.g. "needs DOM extraction to a structured object that screenshot text cannot carry"; "Anthropic computer-use is needed because Cowork has no API surface for X"; "API path exists and is faster".) If no explicit reason, the brief is wrong, fix it before dispatch.
3. If Cowork is the substrate, does the brief say so in plain English? Mention "Cowork" or "side panel" or "ctrl+e" so the hook stays silent and the dispatched fork knows what to drive.
4. If a non-Cowork path is justified, tag the pattern: `[NOT-APPLIED] claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md because <one-sentence reason>`. The tag is the audit trail.

This reflex turns the religious-default into mechanical practice. It runs in the conductor's head; it is verified by the hook; the tag protocol is the durable record.

### 9.3. Anti-patterns this section exists to extinguish

- **Reaching for `cu.click` / `cu.type` / `cu.screenshot` against a Stripe / Vercel / GitHub / Apple ASC / Zernio / Bitbucket dashboard.** These are web SaaS UIs in Tate's logged-in Chrome. Cowork is the substrate. The `cu.*` API is the OS-level fallback for native apps (Teams, Cursor, Xcode). Crossing the streams - using `cu.*` against a webapp - is parallel-infrastructure-to-Cowork.
- **Hand-rolling an `input.click` -> `input.type` -> `input.shortcut` sequence against a webapp.** Same failure as above, just one layer down the stack. Cowork already has the page accessibility tree. The conductor's `input.*` modules are for driving the Chrome shell (focus, ctrl+e to open the side panel, taskbar click to surface the window) - not for driving the webapp inside Chrome.
- **Authoring a "step array" runbook for a webapp goal.** The macro_runbooks pivot now routes web-driving runbooks through Cowork as a natural-language instruction, not a click sequence. If a runbook spec describes a step array against a webapp, the spec is wrong.
- **"Just one quick `cu.*` call" reasoning.** No. The substrate decision is not negotiable per-call. If the target is a web SaaS UI, Cowork is the answer, even for a single click.
- **"Cowork is too slow for this batch of N actions."** If the workflow is N deterministic API calls, the answer is the API, not `cu.*`. Cowork is not competing with the API; it is competing with bespoke `cu.*` / `input.*` against the same webapp. The slowness comparison is between Cowork and the bespoke loop, not Cowork and the API.
- **"I don't want to write the natural-language instruction, the click sequence is more concrete."** The click sequence brittleness against a UI Tate's vendors update without warning is the entire reason Cowork wins. Concreteness against a moving target is fragility, not engineering.

### 9.4. What "religiously" means in shipped behaviour

- The conductor never proposes a `cu.*`-on-webapp or `input.*`-loop-on-webapp dispatch without first naming why Cowork cannot serve, in the brief.
- The hook fires when Step 9.2.2 was skipped. The hook is the safety net; the reflex is the discipline.
- Pattern-application tags ([APPLIED] / [NOT-APPLIED]) are mandatory for the canonical pattern file when the hook surfaces it, per the Phase C forcing function in `~/ecodiaos/CLAUDE.md`. The pattern-tag distribution per Phase C telemetry is the long-run audit signal: if the [NOT-APPLIED] rate stays above 30% week-over-week, either the rule is wrong or the briefs are skipping the reflex.
- The macro_runbooks pivot routes ALL 22 web-driving macros through Cowork. Two OS-level outliers stay on `cu.*` / shell. New web-driving macros default to Cowork; the runbook's `brief` field stores the natural-language Cowork instruction, NOT a step array.
- Section 8's hook + Section 9's reflex + the Phase C forcing-function tags compose: hook fires the warn, reflex prevents the hook from needing to fire, tag closes the audit loop.

### 9.5. Verification (what to grep when this rule is being followed)

- Briefs touching webapps mention Cowork explicitly OR carry a `[NOT-APPLIED]` tag for this pattern.
- `dispatch-events.jsonl` shows Cowork-substrate briefs at high rate; `[COWORK-FIRST WARN]` count trends toward zero over rolling 7d.
- `~/ecodiaos/scripts/hooks/cowork-first-check.sh` log shows few warns relative to total fork+factory dispatch volume.
- Pattern-tag distribution in `/api/telemetry/decision-quality` shows this file's `tagged_silent` rate at less-than 30% over rolling 7d (Phase C health signal).

## Cross-references

- `~/ecodiaos/patterns/use-anthropic-existing-tools-before-building-parallel-infrastructure.md` - the meta-rule. Cowork is one specific Anthropic primitive; this file is one specific application of the meta-rule.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - the existing Chrome-driving doctrine. Cowork is in Chrome, so the same `input.* + screenshot.*` pipeline applies; this file extends that doctrine to a specific Chrome surface (the side panel).
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` - the peer-paradigm tool surface. Driving Cowork is one of many peer-paradigm tasks Corazon can do; the laptop agent's `input.*` + `screenshot.*` modules are the actuators.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - the codification cadence. Tate's directive landed at 20:25; this file is being authored within the same operating window.
- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - the deliverable is the doctrine files shipping, not "I'll codify later."
- `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` - validation discipline applies regardless of runtime. A Cowork-driven macro_runbook is `untested_spec` until a real run succeeds.
- `~/ecodiaos/drafts/macro-pivot-to-computer-use-2026-04-29.md` - superseded primary-runtime decision; cu.* is now the OS-level fallback, Cowork is the primary for web UI driving.
