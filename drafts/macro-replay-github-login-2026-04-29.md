# Macro Replay - github-login first real run (2026-04-29)

**Fork:** fork_mojvqifh_52cb76
**Runbook:** github-login (id `fa2d0bee-0b8c-4780-8c4a-66ac2df657b6`, version 1)
**Run id:** `run_1777456623812_5o55l6`
**Started:** 2026-04-29T09:57:03.812Z UTC (~19:57 AEST)
**Terminal state:** `pause_question` (step 3, on_failure=ask)
**Outcome rating:** **PARTIAL** - 2 of 16 steps passed clean; vision-locate primitive blocked steps 3-16 from running.

---

## TL;DR

The runbook spec is **functionally correct**. Step 1 (screenshot/state_assess) and step 2 (shortcut ctrl+l + type URL + Enter to navigate to github.com/login) both passed. **Step 3 failed because the agent's `vision.locate` primitive is currently mis-authenticated against the Anthropic Vision backend** ("OAuth authentication is currently not supported"). This is a primitive-level outage, not a runbook-spec defect.

The previous fork's claim that github-login was "the simplest validation target because Tate's GitHub session is already logged in on Default Chrome" was **WRONG** - the Default profile is NOT signed into github.com. Chrome's password-manager autofill DID surface saved credentials for "EcodiaTate", which is the actual happy-path mechanism (saved-password autofill, not direct typing).

The runbook DID NOT type any credentials - guard worked correctly because (a) `kv_store.creds.github_login` is unset and (b) vision.locate failed at step 3 before reaching the type steps.

---

## Observed-vs-imagined diff

| # | Spec assumption | Observed reality |
|---|---|---|
| Profile | "Tate's GitHub session is already logged in on Default Chrome" | False. Default profile lands on github.com/login when navigated. Saved-password autofill IS available (Chrome shows "EcodiaTate" autofill suggestion). |
| Vision primitive | runbook calls `vision.locate` which uses Anthropic Vision | Vision call returns HTTP 502 wrapping HTTP 401 `OAuth authentication is currently not supported`. ALL vision-locate steps will fail until the backend creds are fixed. |
| Step 1 (screenshot state_assess) | Screenshots Chrome window | PASS. 503,108 byte PNG captured. |
| Step 2 (shortcut ctrl+l + type + Enter) | Drives Tate's existing Chrome via input.shortcut, no browser.* | PASS. Chrome navigated from claude.ai/cowork (baseline) to github.com/login (post-run). drive-chrome-via-input-tools doctrine validated. |
| Step 3 (vision_locate username_input) | Returns coords for the username field | ERROR. vision.locate backend 502/401. on_failure=ask -> terminal_state=pause_question. |
| Steps 4-16 | Click + type + branch on classification + verify dashboard | UNREACHABLE this run. |

---

## Per-step pass/fail

| Step | Action | Intent | Outcome | Notes |
|---|---|---|---|---|
| 1 | screenshot | state_assess | **PASS** | 503KB PNG, Chrome was foregrounded (claude.ai Cowork tab). |
| 2 | shortcut | navigate | **PASS** | ctrl+l, typed `https://github.com/login`, Enter, networkidle-wait+2500ms. End state confirmed by post-run screenshot showing github.com/login URL bar. |
| 3 | screenshot | vision_locate (username_input) | **FAIL (primitive)** | `vision.locate: backend 502: {"error":"Vision API call failed","status":401,"detail":"OAuth authentication is currently not supported"}`. on_failure=ask, runbook paused. |
| 4-16 | various | various | **NOT RUN** | Blocked by step 3. |

---

## Independent verification (per `forks-self-assessment-is-input-not-substitute`)

The runbook.run response alone is insufficient evidence. Independent verification:

1. **Pre-run screenshot:** `/tmp/macro-replay-2026-04-29/baseline.png` (107,946 bytes, 1366x768 PNG). Confirmed via `file` command. Shows Claude.ai Cowork interface.
2. **Post-run screenshot:** `/tmp/macro-replay-2026-04-29/post-run.png` (58,449 bytes, 1366x768 PNG). Shows github.com/login URL bar, "Sign in to GitHub" heading, Username/Password form, password-manager autofill popup with "EcodiaTate" entry.
3. **Chrome profile:** `chrome.detectCurrentProfile` returned `{profileDir:"Default", displayName:"ecodia.au", app:"ecodia-internal"}` - Default profile, ecodia.au workspace. Independent of runbook.
4. **Diff between baseline and post-run:** Different sites (claude.ai -> github.com/login). Confirms Chrome navigated. Independent of runbook's self-reported "step 2 PASS".

The independent screenshots confirm the runbook's self-report for steps 1-2. They cannot independently confirm step 3 because that step is purely a backend API call that errored before producing any UI artefact.

---

## Specific fixes needed

### Primitive-level (blocks ALL vision-using runbooks)

**1. Fix vision.locate backend authentication.** The Vision API is returning `401 OAuth authentication is currently not supported`. The eos-laptop-agent's vision.locate handler is calling Anthropic Vision with an OAuth token where it should be using an API key (or vice versa). Until this is fixed, NO vision-locate-using runbook can execute past navigation.
- Where: `eos-laptop-agent/tools/vision.js` (or equivalent vision handler module on Corazon)
- Action: Inspect the auth header that vision.locate sends. Confirm whether it should be `Authorization: Bearer sk-ant-...` (API key) or x-api-key. Anthropic's Messages API does NOT accept OAuth tokens; Claude.ai session cookies are not API creds. The agent likely needs `kv_store.creds.anthropic_api_key` (NOT a Claude Max OAuth token) wired into its vision handler.
- After fix: `pm2 restart eos-laptop-agent` mandatory (require-cache; per `eos-laptop-agent-module-cache-requires-restart-after-handler-swap`).

### Runbook-spec level (github-login specifically)

**2. Add a "navigate-then-check-already-signed-in" pre-step.** Currently the runbook unconditionally goes to /login and assumes the form is present. If GitHub session IS active, /login redirects to /, and step 3's vision_locate(username_input) would fail correctly with on_failure=ask. Better: add a pre-step that classifies the post-navigation state into `login_form_present | already_signed_in | unexpected_page` so the happy-path-when-already-signed-in is a planned branch, not an error-recovery surface.

**3. Add a Chrome-password-manager-autofill step.** Observed reality: Chrome's password manager surfaced a saved "EcodiaTate" credential as soon as the username field gained focus. This is a viable login mechanism that does not require typing creds OR storing them in kv_store. Recommended new step between step 4 (focus username) and step 5 (type from kv_store): vision-locate the autofill popup, click the "EcodiaTate" entry, skip the type-credentials path, and verify dashboard. Falls back to kv_store-typed creds if autofill popup not present. This is dramatically safer (no plaintext creds in flight) and matches the GUI-macro-uses-logged-in-session-not-generated-API-key doctrine.

**4. Update step 3 target_description.** Says "Empty text input directly under that label, top form field on the login page". Observed reality: the input field IS empty BUT a Chrome autofill popup overlays the lower portion of the form (covering ~half of the password field and the Sign in button). Vision will need to either dismiss the popup first OR locate the username field above the popup. Add a "dismiss autofill popup" pre-step OR teach vision to ignore the popup overlay.

### Brief-level (the prior fork that authored github-login)

**5. Verify-then-claim discipline.** The prior fork's brief stated "Tate's GitHub session is already logged in on Default Chrome" without independently navigating Chrome to github.com to confirm. That assumption survived into THIS fork's brief. The fix: any "the user is already authenticated at X" claim in a brief MUST cite an artefact (screenshot path + URL) verifying the claim, OR be marked `unverified_assumption` and have its own pre-step in the runbook to test it. Cross-reference: `forks-self-assessment-is-input-not-substitute`.

---

## Artefacts

- **Pre-run screenshot:** `/tmp/macro-replay-2026-04-29/baseline.png` (107,946 bytes)
- **Post-run screenshot:** `/tmp/macro-replay-2026-04-29/post-run.png` (58,449 bytes)
- **Full runbook.run response:** `/tmp/macro-replay-2026-04-29/runbook-run-response.json` (1,742 bytes)
- **Chrome profile probe:** `chrome.detectCurrentProfile` -> `{profileDir:"Default", displayName:"ecodia.au", app:"ecodia-internal"}`

---

## runbook.run response verbatim (truncated)

```json
{
  "ok": true,
  "result": {
    "run_id": "run_1777456623812_5o55l6",
    "runbook": "github-login",
    "started_at": "2026-04-29T09:57:03.812Z",
    "terminal_state": "pause_question",
    "reason": "step 3 (screenshot/vision_locate) error -> on_failure=ask: vision.locate: backend 502: {\"error\":\"Vision API call failed\",\"status\":401,\"detail\":\"{\\\"type\\\":\\\"error\\\",\\\"error\\\":{\\\"type\\\":\\\"authentication_error\\\",\\\"message\\\":\\\"OAuth authentication is currently not supported.\\\"},\\\"request_id\\\":\\\"req_011CaXs3tg2vTtZjXmTGgUWk\\\"}\"}",
    "observations": [
      { "step_index": 1, "action": "screenshot", "intent": "state_assess", "outcome": "pass", "result_summary": { "screenshot_format": "png", "screenshot_bytes": 503108 } },
      { "step_index": 2, "action": "shortcut", "intent": "navigate", "outcome": "pass", "result_summary": { "notes": "shortcut ctrl+l + type + Enter" } },
      { "step_index": 3, "action": "screenshot", "intent": "vision_locate", "vision_target_id": "username_input", "outcome": "error", "error_message": "vision.locate: backend 502: ..." }
    ],
    "context": {}
  }
}
```

---

## Status updates

- **macro_runbooks.github-login:** status SET to `broken_needs_fix` with last_run_at=now() and last_run_outcome=`pause_question_step_3_vision_backend_401`. The runbook spec is fine; the primitive it depends on is broken. Once vision.locate is fixed, re-run before promoting to `validated_v1`.
- **status_board:** new P3 row inserted tracking the vision.locate primitive outage AND queueing stripe-dashboard as the next macro to validate (after vision.locate is fixed - validating any other vision-using macro before then would just hit the same backend 401).
- **Neo4j:** Episode `github-login first replay 29 Apr 2026` written with observed-vs-imagined diff.

---

## Authoring note

This is the FIRST real-run validation of any of the 22 untested_spec macros. Per `macros-must-be-validated-by-real-run-before-codification`: validation is observation, not assertion. Outcome from this run: the runbook authoring framework + runbook.run runtime work; the vision.locate primitive does not. The 22 untested_spec macros remain untested_spec because they all depend on the same broken primitive.

Recommended next conductor action: dispatch a fork to fix vision.locate backend auth, NOT to validate more macros. Validating more vision-dependent macros against a broken vision backend is wasted token spend.
