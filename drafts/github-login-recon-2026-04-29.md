# github-login - Recon (RECON-REQUIRED)

**Date:** 29 Apr 2026
**Author:** fork_mojqajrz_cf6fa6
**Doctrine status:** Phase 1 observation rule violation - hardcoded coords never observed against live screenshot.
**Shipped state:** `D:\.code\eos-laptop-agent\macroHandlers\github-login.js` exists. Registered. Will be dispatched by `macroSuite.run` if called.
**Recommended action:** schedule live observation pass with Tate's hands OR retract.

## What the handler currently assumes

```js
// Coordinates assume Chrome window approximating 1366x768 (Corazon screen size).
const COORDS = {
  email_field:    { x: 683, y: 290 },
  password_field: { x: 683, y: 360 },
  autofill_row:   { x: 683, y: 420 },
  signin_button:  { x: 683, y: 430 },
  twofa_field:    { x: 683, y: 320 },
}
```

These were chosen by the prior fork without ever loading github.com/login on Corazon and inspecting the real layout. The handler's own comment admits the click might land on the wrong element if the page differs from imagination.

## What proper recon would require

1. Drive Tate's existing Chrome (Default profile) to https://github.com/login via `input.shortcut [ctrl, l]` + `input.type` + `input.key enter`.
2. `screenshot.screenshot` the loaded page. Save to `~/ecodiaos/drafts/github-login-page-2026-04-29.png`.
3. From the screenshot, identify true pixel coordinates of:
   - login_field (GitHub uses field id `login_field`, not "email")
   - password input
   - "Sign in" button
   - 2FA OTP field (if redirected to /sessions/two-factor)
4. Verify selector match via `browser.evaluate({script: "document.getElementById('login_field')?.getBoundingClientRect()"})` if browser.* CDP is available, OR by visual screenshot inspection.
5. Update COORDS table in github-login.js with observed values + the exact screen resolution they were derived at.
6. Add a screenshot-verify step BETWEEN clicks in the handler.
7. Record the recon screenshot path in this doc.

## Failure modes the current handler would exhibit

- Wrong-coordinate clicks: the handler clicks at (683, 290) regardless of viewport. If Tate's Chrome is at a different size, miss.
- Login-field-name mismatch: GitHub's input is `login_field`, not the email autofill GitHub uses on the password page. The handler may try to type the email into the wrong field.
- Autofill-row coordinate (683, 420) is a guess about where Chrome's autofill dropdown will render. Likely wrong.
- 2FA detection by `pollFor2FA` - this helper exists in `common.js` but its detection logic was also author-from-imagination. Verify against the actual 2FA challenge page.

## Status

- Handler shipped, dispatch-callable, will likely click on wrong pixels.
- Recon-required: ~5 min of Tate's hands at Corazon console + a fork to update the COORDS table.
- This fork: did NOT execute the recon (would have required Tate-supervised live observation).

## Cross-references

- Handler source: `D:\.code\eos-laptop-agent\macroHandlers\github-login.js`
- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- Drive-Chrome doctrine: `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md`
- Reconciliation: `~/ecodiaos/drafts/macro-phase1-shipped-vs-doctrine-reconciliation-2026-04-29.md`
