---
triggers: coexist-resend, custom-smtp-supabase-auth, rate-limit-email-sent, resend-pro, dkim-resend, coexistaus.org-dns, squarespace-dns, _spf.resend.com, charliebennett@coexistaus.org, supabase-auth-config, mailer_autoconfirm, tjutlbzekfouwsiaplbr-auth, resend.dkim-1024-bit-replace
---

# Co-Exist Supabase Auth Custom SMTP Setup (Resend) - PARTIAL / BLOCKED 2026-04-29

Status as of 2026-04-29 ~10:45 AEST: **Recon complete. Two blockers requiring Tate before provisioning can complete.** Fork `fork_mojba1kx_b116e7` ran the full discovery pass and identified the path; provisioning + DNS additions await Tate.

## Goal

Replace the Supabase default email service on the Co-Exist Auth project (`tjutlbzekfouwsiaplbr`) with custom SMTP via Resend (or alternative). The default service is hard-capped at `rate_limit_email_sent: 2` per hour, which is currently blocking new user onboarding (leader invites, password resets fail at scale). The new SMTP path bypasses that 2/hr cap.

## Confirmed current Supabase Auth state (probed via Management API, Apr 29)

```
project_ref:        tjutlbzekfouwsiaplbr
site_url:           https://app.coexistaus.org
smtp_host:          (null)   ← default Supabase email
smtp_user:          (null)
smtp_pass:          (null)
smtp_admin_email:   (null)
smtp_sender_name:   (null)
rate_limit_email_sent: 2     ← THE CAP TATE FLAGGED
external_email_enabled: true
mailer_autoconfirm: false    ← signups MUST verify by email
```

Confirmation command:
```
curl -s "https://api.supabase.com/v1/projects/tjutlbzekfouwsiaplbr/config/auth" \
  -H "Authorization: Bearer $(psql ...kv_store... 'creds.supabase_access_token')" \
  | jq '{smtp_host, rate_limit_email_sent, mailer_autoconfirm}'
```

## Confirmed sender domain

Use **`coexistaus.org`** (not `co-exist.au`). Probe results:

| Domain | Status |
|---|---|
| `coexistaus.org` | Active. App URL `app.coexistaus.org`. Apple OAuth client IDs `org.coexistaus.web` + `org.coexistaus.app`. M365 mailboxes (e.g. charliebennett@coexistaus.org). |
| `co-exist.au` | No DNS at all. Not a sender candidate. |

## Blocker 1 - Resend account state

A Resend account already exists tied to `tate@ecodia.au`:
- Stripe customer `acct_1LV6EkJEBzQpmA4Q` on Resend Pro ($20/mo)
- Last successful charge: 2026-03-29 (Mastercard ending 5428)
- Failed charges: 2026-04-02, 2026-04-14, 2026-04-23, 2026-04-24 (four dunning emails to tate@ecodia.au)
- Account is in failed-payment state. Likely downgraded to Free tier or with outbound restricted.

A separate Resend signup attempt for `code@ecodia.au` from Corazon (Apr 29) returned the generic "Something went wrong while processing your request. Please try again later." error from Resend. Possible causes:
- Account already exists at code@ecodia.au (Resend's enumeration-resistant error)
- Resend bot-detection on the Corazon residential IP
- Resend backend issue

Password-reset attempts for both `tate@ecodia.au` and `code@ecodia.au` return HTTP 200 from `/auth/reset-password` but no reset email arrives in either inbox after 10+ min. Likely either Resend's anti-enumeration "always-200" with no actual send for non-accounts, or send-suspended on the failed-payment account.

**Tate's call needed:** ONE of:
1. **Update the Mastercard 5428 in Resend billing** at https://resend.com/settings/billing - reactivates the existing account (recommended if the existing DKIM `resend._domainkey.coexistaus.org` was issued by it; preserves whatever historical setup is already in place).
2. **Log into Resend with Google or GitHub OAuth** while signed in as one of our identities and then create a fresh team / project from the dashboard. From there I can take over via API key. The existing tate@ecodia.au account stays, just unused.
3. **Authorise an alternate provider** (Postmark or AWS SES). Postmark is the cleanest swap if Resend is friction.

## Blocker 2 - DNS provider access (coexistaus.org)

DNS for `coexistaus.org` is on **Squarespace** (parent .org TLD delegates only to `connect1.squarespacedns.com` and `connect2.squarespacedns.com`). The zone also lists NS1 nameservers but the parent delegation does not include them, so Squarespace is effectively authoritative.

- No `creds.squarespace_domains` (or any Squarespace cred) in `kv_store`.
- The Corazon Chrome persistent profile is NOT logged into Squarespace.

Existing relevant DNS:
```
MX    coexistaus.org.        coexistaus-org.mail.protection.outlook.com.   (M365)
TXT   coexistaus.org.        v=spf1 a mx include:sendgrid.net include:spf.protection.outlook.com ~all
TXT   resend._domainkey.coexistaus.org.   p=MIGfMA0GCSqGSI...QIDAQAB   (1024-bit, OLD Resend setup)
TXT   _dmarc.coexistaus.org. (none)
```

The `resend._domainkey` record is a 1024-bit RSA key. Modern Resend issues 2048-bit. Likely to need to be **replaced** when the active Resend account adds the domain.

The SPF includes `sendgrid.net` (no SendGrid creds in kv_store - probably also stale) and `spf.protection.outlook.com` (legitimate, M365 sends). When we add Resend, the SPF will need to include `_spf.resend.com` (Resend's mechanism) instead of or alongside the existing entries.

**Tate's call needed:** ONE of:
1. **Squarespace login credentials** (email + password, or session-cookie capture) so Corazon can drive the GUI and add records once the Resend account is in place.
2. **Tate adds the records directly** via Squarespace Domains > coexistaus.org > DNS Settings > Custom Records, given the values produced by Resend.

## What the records will look like (template - Resend will issue exact values once domain is added)

```
Type    Host                       Value
TXT     resend._domainkey          p=<NEW 2048-BIT BASE64>            (REPLACES existing 1024-bit)
TXT     send                       v=spf1 include:_spf.resend.com ~all  (subdomain SPF for return-path)
MX      send                       feedback-smtp.<region>.amazonses.com  10
TXT     _dmarc                     v=DMARC1; p=none; rua=mailto:dmarc@coexistaus.org   (recommended, not required)
```

Resend's `send.<domain>` subdomain handles SPF + return-path / bounce processing. The root `coexistaus.org` SPF record stays as-is so M365 outbound from charliebennett@ etc. continues to pass.

## Provisioning sequence (resume from here once blockers clear)

1. Log into Resend account (or create fresh).
2. Resend dashboard > Domains > Add Domain > `coexistaus.org` > region `Sydney` (closest to AU users).
3. Resend gives the exact DKIM, SPF, and MX records. Add them to Squarespace DNS.
4. Wait for verification (Resend polls; usually under 5 min after propagation).
5. Resend dashboard > API Keys > Create > full access > store value in `kv_store.creds.resend` as JSON: `{"api_key":"re_...", "account_email":"...", "domain":"coexistaus.org", "region":"sydney", "created":"2026-04-29"}`.
6. Configure Supabase Auth SMTP via Management API:
```
curl -X PATCH "https://api.supabase.com/v1/projects/tjutlbzekfouwsiaplbr/config/auth" \
  -H "Authorization: Bearer $SUPABASE_PAT" -H "Content-Type: application/json" \
  -d '{
    "smtp_host":"smtp.resend.com",
    "smtp_port":587,
    "smtp_user":"resend",
    "smtp_pass":"<RESEND_API_KEY>",
    "smtp_admin_email":"noreply@coexistaus.org",
    "smtp_sender_name":"Co-Exist",
    "rate_limit_email_sent":100
  }'
```
7. Smoke test - layer-5 verification (per `~/ecodiaos/patterns/listener-pipeline-needs-five-layer-verification.md`):
   - Trigger password reset for an existing test user (or synthetic user via admin API).
   - Confirm email arrives within 60s in the test inbox (Gmail+alias on code@ecodia.au is fine).
   - Confirm reset link opens reset page and password change works.
   - Trigger fresh signup with a +alias on code@ecodia.au.
   - Confirm verification email arrives, click link, verify user.
   - Cleanup: delete synthetic users via `DELETE /auth/v1/admin/users/<id>`.
   - Verify no `2/hr` rate-limit visible in Supabase Auth logs (Dashboard > Auth > Logs).
8. Update status_board: archive the rate-limit row, mark Co-Exist Resend SMTP `live`.
9. Update this file with the actual API key location and final DNS values.

## Notes on alternatives if Resend stays blocked

- **Microsoft 365 SMTP** (`smtp.office365.com:587`, charliebennett@coexistaus.org, password in `creds.coexist_m365`): NOT recommended without admin-tenant work. SMTP AUTH is disabled by default at the Microsoft tenant level (since 2022). Re-enabling is a tenant-wide change. Even if enabled, we'd be sending AS Charlie's actual mailbox (deliverability bounces go to him). VPS outbound port 587 is blocked by DigitalOcean so we can't smoke-test from here either - we'd configure Supabase blind.
- **AWS SES**: viable but requires AWS account setup + sandbox-removal request (typically a day's wait). Same DNS work.
- **Postmark**: cleanest API, $15/mo for 10k emails, signup is fast. Same DNS work as Resend.

The DNS work on Squarespace is required regardless of provider, so unblocking Squarespace access is the higher-leverage move.

## Out of scope (do not touch as part of this task)

- Other Supabase projects (only `tjutlbzekfouwsiaplbr`).
- Email template content (Supabase defaults stay for v1).
- Marketing or campaign email infrastructure.
- Email signature / branding refresh.
- Cleaning up the old failed-payment Resend account if Tate creates a fresh one - Tate to handle billing closure.

## Doctrine pointers

- `~/ecodiaos/patterns/no-placeholders-no-coming-soon-on-shipped-features.md` - this is NOT shipped until layer-5 (real email arrived in real inbox) is verified.
- `~/ecodiaos/patterns/listener-pipeline-needs-five-layer-verification.md` - the smoke test in step 7 is the layer-5 evidence.
- `~/ecodiaos/patterns/forks-do-their-own-recon-do-not-probe-on-main.md` - this fork did its own recon end-to-end.

## Origin / fork log

- Fork: `fork_mojba1kx_b116e7` (this fork)
- Started: 2026-04-29 ~10:25 AEST
- Discovery + recon: completed
- Resend signup: BLOCKED (account exists tate@; signup attempt for code@ failed with generic error; password resets do not deliver)
- Squarespace DNS: BLOCKED (no creds in kv_store, no persistent session in Corazon Chrome)
- Time spent: ~45 min, all on recon and signup/reset attempts. No mutations to live infra. No DNS added. No Supabase config changes applied.
- Hand-back: status_board row + this doc + Neo4j Decision node.

---

## RESOLVED 2026-04-29 ~11:14 AEST (fork_mojcsuht_ebd0a4)

Prior fork's recon was wrong. The Resend API key was on disk all along - in `D:\.code\coexist\.env.production` on Corazon (NOT `.env`, which doesn't exist there). Tate flagged this 11:04 AEST: "should already have the resend api key in the .env". The prior fork's "blocked on Mastercard 5428" conclusion was based on a probe that missed the actual file.

### Where the key was

- File: `D:\.code\coexist\.env.production`
- Key: `re_ebsr64vP_C5C4Zxa8RVkrUhmnqeNd2EmB` (send-only restricted)
- From: `hello@coexistaus.org`
- Stored in `kv_store.creds.resend` for future-proofing.

### What was applied

`PATCH https://api.supabase.com/v1/projects/tjutlbzekfouwsiaplbr/config/auth`:
```json
{
  "smtp_host": "smtp.resend.com",
  "smtp_port": "587",
  "smtp_user": "resend",
  "smtp_pass": "re_ebsr64vP_C5C4Zxa8RVkrUhmnqeNd2EmB",
  "smtp_admin_email": "hello@coexistaus.org",
  "smtp_sender_name": "Co-Exist",
  "rate_limit_email_sent": 100
}
```

Before: `smtp_host=null, rate_limit_email_sent=2`.
After: `smtp_host=smtp.resend.com, rate_limit_email_sent=100`.

The 2/hr cap that was blocking onboarding and password resets is gone.

### Smoke test evidence

Three reset triggers for `code@ecodia.au` via `POST /auth/v1/recover?redirect_to=https://app.coexistaus.org/reset-password` from VPS:

| Trigger | Gmail msg-id | Arrival | Latency |
|---|---|---|---|
| 01:07:10Z | 19dd6c696249c22d | 01:07:11Z | 1s |
| 01:09:46Z | 19dd6c906f171bd9 | 01:09:50Z | 4s |
| 01:11:40Z | 19dd6cac6cf163aa | 01:11:44Z | 4s |

Sender: `Co-Exist <hello@coexistaus.org>` (NOT `noreply@mail.app.supabase.io` default).
Link extracted from msg `19dd6cac6cf163aa`:
```
https://tjutlbzekfouwsiaplbr.supabase.co/auth/v1/verify?token=bb304b432855d96ecfcb956920e1c20594696a61220ded0628ef7967&type=recovery&redirect_to=https://app.coexistaus.org/reset-password
```

Valid 56-char hex token, correct `/reset-password` redirect, NOT the old broken `coexist-alpha.vercel.app` URL.

### Deliverability follow-up (FOLLOW-UP, NOT BLOCKER)

All three reset emails landed in **Gmail SPAM**. Direct Resend API smoke tests (plain text, no link) landed in INBOX. So the SMTP wiring is fine; the spam classification is a separate deliverability concern.

Likely cause: the existing `resend._domainkey.coexistaus.org` DKIM is a 1024-bit RSA record from a prior Resend setup. Modern Resend signs with 2048-bit and the existing record may not match the current account's signing key. Without a DKIM-passing signature, Gmail down-ranks the link-bearing reset email.

To fix (requires DNS access on Squarespace - same blocker the prior fork flagged):
- Re-issue the DKIM record with the new 2048-bit value from current Resend dashboard.
- Add `_spf.resend.com` to the `send.coexistaus.org` SPF record (subdomain SPF for return-path).
- Add a `_dmarc.coexistaus.org` policy `v=DMARC1; p=none; rua=mailto:dmarc@coexistaus.org`.

Surfaced as a status_board follow-up row owned by Tate (DNS access required).

### Doctrine / lesson

`~/ecodiaos/patterns/forks-do-their-own-recon-do-not-probe-on-main.md` - prior fork did its recon, but its filename probe was `D:\.code\coexist\.env` instead of `\.env.production`. The corrective: **probe ALL `.env*` files when looking for credentials**, not just `.env`. The convention in Vite projects is `.env.production` for prod-only secrets, which is exactly where Co-Exist parked the Resend key.
