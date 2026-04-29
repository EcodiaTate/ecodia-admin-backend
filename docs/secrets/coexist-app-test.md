---
triggers: coexist, coexist-app, coexist-test, smoke-test, visual-verify, puppeteer-coexist, coexist-test-account, coexistaus.org-app
class: gui-macro-replaces
owner: ecodiaos
---

# creds.coexist

Co-Exist app test account credentials (the END-USER app, not the M365 admin tenant - that's `creds.coexist_m365`). Used for smoke tests, visual verification, and any agent-driven flow that needs to log into the Co-Exist app as a regular user.

## Source

Co-Exist admin (Charlie or delegated) provisioned this account on the Co-Exist app for Ecodia testing purposes.

## Shape

object `{url, email, password}`

## Used by

- Puppeteer smoke tests post-deploy
- `~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md` (this is one of the canonical "stored client credentials" the visual-verify gate consumes)
- Corazon browser sessions for Co-Exist app testing

## Replaceable by macro?

N/A - this IS the test/macro credential.

## Rotation

Co-Exist's discretion (typically rare; test accounts are sticky).

## Restoration if lost

1. Co-Exist admin resets the test account password.
2. UPSERT `creds.coexist.password`.

## Failure mode if missing

- Smoke tests fail at login.
- Visual-verify merge gate cannot run automatically; falls back to Tate-driven review.

## Drift note

`~/ecodiaos/clients/coexist.md:133` references `creds.coexist_test` which does NOT exist - the actual row is `creds.coexist`. That doc reference is a stale typo; will be corrected in this fork as a SAFE-TO-FIX doc-only edit.
