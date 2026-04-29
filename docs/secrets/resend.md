---
triggers: resend, transactional-email, smtp, email-api, re_, email-domain, dkim, coexist-resend, ecodia-email-out
class: programmatic-required
owner: ecodiaos
---

# creds.resend

Resend API key + domain metadata for transactional email. Used by server-to-server email cron (no human in loop) - exactly the case where API keys are the right answer per the GUI-macro doctrine.

## Source

resend.com/dashboard > API Keys > Create > full access scope.

## Shape

object `{api_key, domain, from_email, from_name, scope, source, fork, stored}`

## Used by

- `~/ecodiaos/clients/coexist-resend-smtp-setup-2026-04-29.md` (canonical Resend integration plan for Co-Exist)
- Future transactional email integrations (Supabase auth emails, password resets, app notifications)

The `domain` field identifies which DKIM-verified Resend domain is in use (currently `coexistaus.org` for Co-Exist).

## Replaceable by macro?

No. Email cron is server-to-server; the API key IS the integration.

## Rotation

On-leak-only.

## Restoration if lost

1. resend.com dashboard > API Keys > Create new key, full access.
2. UPSERT `creds.resend.api_key` with the new value.
3. Old key remains valid until revoked from the same page.

## Failure mode if missing

All transactional email from anywhere consuming this row fails. Co-Exist password resets, registration confirmations, etc., halt.

## Doctrine

This is the textbook case where `gui-macro-uses-logged-in-session-not-generated-api-key.md` says API keys are correct - workflow has no human GUI session in the loop, runs on server cron, needs deterministic auth. Do NOT try to replace this with a Chrome-driven macro.
