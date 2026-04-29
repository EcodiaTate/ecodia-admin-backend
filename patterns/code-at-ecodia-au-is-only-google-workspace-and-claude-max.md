---
triggers: code@ecodia.au, code-ecodia-au, code account, second account, dual account, vendor identity, github account, bitbucket account, vercel account, stripe account, apple account, second github, separate github, code@ login, fork github login, vendor login, account confusion, two accounts
priority: high
canonical: true
---

# code@ecodia.au is a Google Workspace + Anthropic Claude Max email ONLY - it is NOT a separate identity at any other vendor

## Rule

The email `code@ecodia.au` exists in exactly two places:

1. **Google Workspace** - the Gmail/Calendar/Drive inbox at `code@ecodia.au` (alongside `tate@ecodia.au`).
2. **Anthropic Claude Max** - the dedicated second Claude account used by Factory CLI sessions, sized so Factory's energy budget is independent of the conductor's.

It does NOT exist at any other vendor. Specifically:

- **GitHub:** ONE account only. Tate's personal account. The `EcodiaTate` org is owned by Tate's personal GitHub.
- **Bitbucket:** ONE Atlassian account. `code@ecodia.au` is the *username* on the API key (`creds.bitbucket_account_email`) but the account itself is Tate's. There is no separate "code@" Bitbucket profile.
- **Vercel:** ONE account. Tate's. Connected via the EcodiaTate GitHub org.
- **Stripe:** ONE account per Ecodia entity (Pty Ltd / DAO LLC). Logged in as Tate. No "code@" Stripe identity.
- **Apple Developer / App Store Connect:** ONE Apple ID. Tate's. There is no `code@` Apple ID.
- **AWS:** ONE root account, signed in as Tate (or on the DAO entity).
- **Cloudflare / DigitalOcean / Supabase / Neo4j / Resend / Canva / Xero / RevenueCat / Zernio / etc.:** ONE account each, logged in as Tate (or on the entity that owns it).

If a workflow seems to require "logging in as code@" to a vendor that is not Google Workspace or Anthropic Claude Max, the workflow is wrong. The correct path is one of:

- (a) Use Tate's existing logged-in session via the Corazon GUI-macro path (input.* + screenshot.* + macro.*).
- (b) Use the existing vendor API token / OAuth token already provisioned on the VPS, which authenticates as Tate's account or the entity.
- (c) If neither is available, the credential is genuinely missing - check `~/ecodiaos/docs/secrets/` for the vendor's file, and if absent, surface as `next_action_by='tate'` to provision through Tate's existing login.

## Why this matters

The conductor / forks have two real adjacencies:

1. The two Claude Max accounts (`tate@` and `code@`). The Factory CLI doctrine genuinely uses both, with autoswitch between them. This is real.
2. The two Google Workspace inboxes. Both are checked by email-triage. This is real.

The danger is generalising "we have two accounts" to other vendors. The leakage looks like:

- A fork briefed to "open a PR" reasons "I should authenticate the PR as code@ since this is a code-bot operation" - and tries a `gh auth login` flow targeting a non-existent identity.
- A fork briefed to "deploy to Vercel" tries to `vc login` as `code@ecodia.au` - which would create a NEW Vercel account (not what we want) or fail (which wastes time).
- A fork drafting a Bitbucket PR tries to use `code@ecodia.au` as the Bitbucket *user* on the git remote - that fails because the magic git username is `x-bitbucket-api-token-auth`, not the email (see `~/ecodiaos/docs/secrets/bitbucket.md`).
- A fork preparing an iOS submission tries to log into App Store Connect as `code@` - there is no such Apple ID.

Each of these wastes time, may create rogue accounts at the vendor, and confuses downstream attribution. The doctrine rule is: outside of Google Workspace and Anthropic, `code@ecodia.au` is not a recognisable identity. Don't assume it exists.

## Do

- Treat `code@` and `tate@` as TWO Google inboxes and TWO Claude accounts only. Same single identity at every other vendor.
- Use existing VPS-side `gh auth` / `git config` for GitHub operations. It's already Tate's account.
- For any vendor that requires a logged-in browser session, drive Tate's Default Chrome profile on Corazon via `input.*` + `screenshot.*` (per `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md`).
- Check `~/ecodiaos/docs/secrets/` BEFORE assuming a separate identity is needed - the credential file documents which login the API key / token authenticates as.
- If a brief seems to require a `code@<vendor>` identity, treat it as a brief error and ask which existing identity is correct, not a new account to create.

## Do not

- Do NOT `gh auth login` as code@ on the VPS or Corazon. The VPS already has Tate's GitHub auth.
- Do NOT switch `git config user.email` to `code@ecodia.au` when committing - the Bitbucket/GitHub commit attribution rules are independent of the workflow account; commits are Tate's regardless of which conductor stream produced them.
- Do NOT create new vendor accounts under `code@ecodia.au` to "pair" with Tate's account. The two-Claude-Max symmetry does not extend.
- Do NOT assume an `Authorization: Bearer <code@ token>` header pattern works for vendors other than Anthropic. Each vendor's auth is what's documented in `~/ecodiaos/docs/secrets/`.
- Do NOT instruct a fork to "authenticate as the code@ identity" for any non-Google, non-Anthropic operation.

## Briefing protocol

When writing a fork brief that touches any vendor login:

1. Identify the vendor.
2. Check `~/ecodiaos/docs/secrets/<vendor>.md` for the documented auth.
3. State explicitly in the brief: "Auth: Tate's existing <vendor> account via <method>" - never "auth as code@".
4. If a fork's report mentions "logged in as code@" or "tried to authenticate as code@" against a non-Google/non-Anthropic vendor, treat that as a regression signal and correct the brief on next dispatch.

## Cross-references

- `~/ecodiaos/docs/secrets/INDEX.md` - canonical credential registry, names which identity each token authenticates as.
- `~/ecodiaos/docs/secrets/bitbucket.md` - explicit example: API key uses email as REST username, magic string as git username, but the account itself is Tate's single Atlassian identity.
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` - the right way to use Tate's existing logged-in sessions for vendor work without provisioning new credentials.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` - GUI-first path for any vendor that requires an interactive login.
- `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md` - the laptop+browser+saved-creds route is always Tate's identity, never a code@ identity.

## Origin

29 Apr 2026, 17:44 AEST. While 3 forks were running (macro retraction, credit-exhaustion implementation, chrome.js module), Tate flagged: "github is just my account, no code@ account, one of the agents is trying to log into code@ github account."

The leakage was the conductor's brief implicitly inheriting the two-Claude-Max symmetry into other vendors. Specifically the credit-exhaustion fork was about to open a PR on ecodiaos-backend and may have reasoned that the PR should authenticate as a `code@` GitHub identity (the brief did not say so explicitly, but the fork's chain-of-thought could have derived it from the broader context).

A clarifying message was sent to all 3 forks within 2 minutes. This pattern file codifies the rule so future forks read the constraint at brief-render time rather than discovering it through a Tate correction mid-flight.
