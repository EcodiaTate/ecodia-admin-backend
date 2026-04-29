---
triggers: xero, bookkeeping, xero-login, xero-gui, xero-dashboard, xero-org, code@ecodia.au-xero, ecodia-xero
class: gui-macro-replaces
owner: ecodiaos
---

# creds.xero_code_login

Xero account login provisioned for `code@ecodia.au`. GUI credential - drives Xero workflows through Tate's logged-in Chrome on Corazon. The MCP `xero_*` tools use a SEPARATE OAuth integration that is NOT held in this row.

## Source

Xero account provisioned for `code@ecodia.au` against the Ecodia organisation.

## Shape

object `{email, password, first_name, last_name, location, org, org_short_code, notes, created_at}`

## Used by

- Xero GUI macro paths via Corazon Chrome
- Reference for the Ecodia Xero org metadata (`org_short_code`)
- NOT used by the MCP `xero_*` tools (those use OAuth, not held in kv_store today)

## Replaceable by macro?

N/A - this IS the macro credential.

For headless Xero access, the OAuth path applies (a separate integration; row not in this registry because no row currently exists).

## Rotation

Tate's discretion. Xero password reset available via xero.com.

## Restoration if lost

1. xero.com > Sign in > Forgot password.
2. Reset via email link (delivered to `code@ecodia.au`).
3. UPSERT `creds.xero_code_login.password`.

## Failure mode if missing

Xero GUI macros (e.g. attaching receipts, manually categorising transactions, viewing reports through the dashboard) fail at login. Bookkeeping MCP tools (which use the separate OAuth integration) are unaffected.

## Drift note

Xero has both a GUI session (this row) AND an OAuth integration (not in this registry). The OAuth integration backs the bookkeeping MCP. If the OAuth integration ever needs an explicit kv_store row, author it in this directory at that time.
