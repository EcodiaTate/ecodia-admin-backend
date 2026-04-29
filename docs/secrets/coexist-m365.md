---
triggers: coexist, m365, microsoft365, charlie, charliebennett, coexistaus.org, outlook, office365, sharepoint, teams-coexist, m365-login
class: gui-macro-replaces
owner: tate
---

# creds.coexist_m365 + creds.coexist_m365_tate

Two M365 user logins for Co-Exist's tenant - one for `charliebennett@coexistaus.org` (the primary admin account Ecodia operates on Co-Exist's behalf), one for Tate's secondary account. Both are GUI-credential rows used to drive the M365 web GUI through Tate's Chrome on Corazon.

| Key | Shape | Account |
|---|---|---|
| `creds.coexist_m365` | object `{email, password, note}` | `charliebennett@coexistaus.org` |
| `creds.coexist_m365_tate` | object `{email, password, note}` | Tate's secondary Co-Exist M365 account (cross-account testing) |

## Source

Co-Exist M365 admin-issued credentials. Charlie's account is the primary; Tate's was provisioned for cross-account testing (e.g. simulating non-admin user perspectives).

## Shape

Two object rows, each `{email, password, note}`.

## Used by

- Corazon Chrome browser sessions for Co-Exist M365 GUI workflows (admin center, Outlook, Excel online, SharePoint)
- `~/ecodiaos/clients/coexist-resend-smtp-setup-2026-04-29.md` (cited for SMTP path reasoning - SMTP path was rejected per that doc; Resend won)
- Future Co-Exist tenant administration tasks

## Replaceable by macro?

The WORKFLOWS this enables ARE macro-replaceable; this row provides the credential the macro types into the M365 login form. Equivalent to a saved-password autofill, but explicit so the agent can type even when password manager isn't loaded.

## Rotation

Per-Co-Exist-policy. M365 tenant admins can enforce password rotation; Co-Exist's policy not formally documented here.

## Restoration if lost

1. Co-Exist admin (Charlie for his account, or delegated for Tate's) resets the password.
2. UPSERT the relevant row's `password` field.

## Failure mode if missing

Any Co-Exist M365 GUI macro fails at login. Manual workarounds available (Tate logs in directly), but agent-driven flows blocked.

## Note on SMTP

`~/ecodiaos/clients/coexist-resend-smtp-setup-2026-04-29.md:129` documents that **Microsoft 365 SMTP** (`smtp.office365.com:587` with charliebennett) is NOT recommended:
- SMTP AUTH is disabled by default at the Microsoft tenant level (since 2022)
- Re-enabling is a tenant-wide change
- We'd be sending AS Charlie's actual mailbox (deliverability bounces go to him)
- DigitalOcean blocks outbound port 587 from VPS anyway

So `creds.coexist_m365.password` is NOT consumed for SMTP today. It's a GUI-only credential.
