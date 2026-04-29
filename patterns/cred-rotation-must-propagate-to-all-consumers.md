---
triggers: rotation, propagation, kv_store, vercel-env, supabase-secrets, edge-function, smtp, resend, credential-update, all-consumers, cred-rotation, rotate-credential, rotate-key, key-rotation, secret-rotation, vendor-rotation, smtp-rotation, oauth-rotation, api-key-rotation, password-rotation, deploy-env-vars, supabase-edge-secrets, secrets-list, multi-surface-rotation, post-rotation-audit, downstream-consumers
---

# Credential rotation must propagate to all consumer surfaces, not just kv_store

Rotating a credential is not "update kv_store and done." A credential typically has multiple consumer surfaces (kv_store canonical, Vercel project env vars, Supabase Auth/SMTP settings, Edge Function secrets, repo deploy-time injection, downstream services, runbook docs). Updating one surface and treating the rotation as complete leaves stale credentials live in the surfaces I forgot, and the symptom appears as "the new key works locally but X is broken in production" - or worse, silently as "X is using the old key without anyone noticing because the old key has not been revoked yet."

The rotation is complete only when every consumer surface has either been updated to the new value OR explicitly cleared as not-applicable for this credential. Anything in between is a half-rotated state that produces silent inconsistency.

## Do

- DO maintain a per-credential consumer-surface list in `~/ecodiaos/docs/secrets/<name>.md`. Every doc file lists which surfaces hold a copy of that credential.
- DO audit ALL consumer surfaces BEFORE marking a rotation complete: kv_store, Vercel envs, Supabase Auth/SMTP/OAuth provider settings, Supabase Edge Function secrets, deploy-time env injection, downstream services, runbook references.
- DO verify each surface AFTER updating. The verification step is a separate action from the update step; both must happen.
- DO update the credential's doc file (`~/ecodiaos/docs/secrets/<name>.md`) when a new consumer surface is identified, BEFORE the next rotation.
- DO revoke the old credential at the issuing service (Resend, Stripe, Apple, etc) AFTER all surfaces are confirmed updated. Revoking before the surfaces are updated breaks production.
- DO record the rotation in Neo4j as a Decision node with the surfaces audited, the timestamp, and the reason (scheduled rotation, suspected compromise, vendor-required, key-in-logs).
- DO include the consumer-surface list in the credential's status_board context so a future operator (me, in a new session) can verify completeness.

## Do NOT

- DO NOT mark a rotation complete after only updating kv_store. kv_store is the canonical store; it is not the only consumer.
- DO NOT skip Vercel env vars when the credential is consumed by a Vercel-deployed app. Vercel envs are per-project AND per-environment (development / preview / production); update all three or document why one is excluded.
- DO NOT skip Supabase Auth / SMTP / OAuth provider settings if the credential is an SMTP password or OAuth secret. Supabase stores these separately from kv_store; updating kv_store does not update Supabase Auth.
- DO NOT skip Supabase Edge Function secrets if the credential is consumed inside an Edge Function. `supabase secrets list` is the verification command; if the credential appears there, it must be updated.
- DO NOT commit credentials to repo `.env.production` or `.env.local` files. If a checked-in env file references the credential, the rotation surface is the deploy-time env injection layer, NOT the file. Revoke and re-issue if a checked-in file leaked.
- DO NOT trust verbal claims of "I updated it everywhere." Audit the surfaces listed in the doc file. The doc file is the contract.
- DO NOT skip runbook / pattern-file updates if a doc names the credential by value (e.g. "use API key XYZ"). Stale docs surface stale values.
- DO NOT revoke the old credential before all surfaces are updated. Revoke last, after verification.

## Consumer-surface checklist (run for every rotation)

| # | Surface | How to verify |
|---|---|---|
| 1 | `kv_store.creds.<name>` | `db_query "SELECT key, updated_at FROM kv_store WHERE key = 'creds.<name>'"` |
| 2 | Vercel project env vars (per-env: dev / preview / production) | Vercel dashboard or `vercel env ls --project <slug>` |
| 3 | Supabase Auth / SMTP / OAuth provider settings | Supabase dashboard, Authentication > Providers / SMTP |
| 4 | Supabase Edge Function secrets | `supabase secrets list --project-ref <ref>` |
| 5 | Repo `.env.production` / `.env.local` | Grep checked-in env files; should be empty for live creds |
| 6 | Deploy-time env injection layer (CI/CD, PM2 ecosystem.config.js, Docker Compose, k8s secrets) | Per-platform; for our VPS, `pm2 env <id>` |
| 7 | Downstream services holding a copy (client repo, partner integration, third-party webhook) | Per-credential; documented in `~/ecodiaos/docs/secrets/<name>.md` |
| 8 | Runbook / pattern-file references that name the value | Grep `~/ecodiaos/docs/`, `~/ecodiaos/patterns/`, `~/CLAUDE.md`, `~/ecodiaos/CLAUDE.md` |

For every rotation, walk the checklist top to bottom. Surfaces 1-6 are platform-generic. Surface 7 is per-credential. Surface 8 is per-doctrine.

## Protocol (the rotation sequence)

1. **Identify the credential and the trigger.** Scheduled rotation, suspected compromise, vendor-required, key found in logs, key-in-public-repo.
2. **Read the credential's doc file** at `~/ecodiaos/docs/secrets/<name>.md`. The doc file lists the surfaces. If the doc file does not exist, author it BEFORE rotating.
3. **Generate or obtain the new credential** at the issuing service. Do NOT revoke the old one yet.
4. **Update kv_store first.** This is the canonical store; subsequent surfaces source from here when possible.
5. **Update each consumer surface** per the checklist above. After each update, run the verification command.
6. **Smoke-test downstream.** A trivial probe that exercises the credential end-to-end (sending a test email, hitting a protected API, completing an OAuth handshake).
7. **Revoke the old credential** at the issuing service. The new credential is now sole authority.
8. **Update the doc file's "last rotated" timestamp** and any new surfaces discovered during the rotation.
9. **Log the rotation** as a Neo4j Decision node with surfaces audited, timestamp, reason.
10. **Update status_board** if the rotation was tracked there. Set `archived_at = NOW()` if the rotation row is now resolved.

## Worked example - Resend SMTP key rotation

If the Resend SMTP credential rotates:

- Surface 1 (kv_store): update `creds.resend_smtp_password`
- Surface 2 (Vercel): update `RESEND_SMTP_PASSWORD` on every Vercel project that sends email (this CRM, the marketing site, any client app using Resend)
- Surface 3 (Supabase Auth): update SMTP password in Supabase Auth > SMTP settings - magic-link emails go through this surface
- Surface 4 (Edge Function secrets): if any Edge Function calls Resend directly, `supabase secrets set RESEND_SMTP_PASSWORD=<new>`
- Surface 5 (.env files): grep checked-in env files; if any leaked, separate incident
- Surface 6 (deploy-time injection): VPS PM2 process env (`ecosystem.config.js`); restart relevant processes after update
- Surface 7 (downstream): any client app in `~/workspaces/*/be` or `~/workspaces/*/fe` that holds the Resend key in its own deploy env
- Surface 8 (docs): grep `~/ecodiaos/docs/`, `~/ecodiaos/patterns/`, both CLAUDE.md files for `resend` references that name a value

Single missing surface = silent half-rotation = production breakage when the old key is revoked.

## Origin

Tate flagged the cross-system propagation discipline 29 Apr 2026 19:42 AEST during the broader "Stop fucking asking me, and just make good decisions" exchange that produced `decide-do-not-ask.md`. The specific concern was Resend SMTP: rotating the kv_store entry without auditing Supabase Auth SMTP, Vercel env vars, and downstream consumers leaves stale credentials live in the surfaces I forgot.

This pattern formalises the consumer-surface checklist and forces the rotation to be a multi-step audited process rather than a single kv_store update. The doc-file-per-credential layer (`~/ecodiaos/docs/secrets/`) is the contract that records which surfaces a given credential touches.

## Cross-references

- `~/ecodiaos/docs/secrets/INDEX.md` - the doc-file-per-credential registry. Every cred listed here MUST list its consumer surfaces.
- `~/ecodiaos/CLAUDE.md` "Credentials" section - the cross-system rotation discipline block points here.
- `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` - upstream rule. Sometimes the right answer to "which credential to rotate" is "no programmatic credential at all - use the logged-in GUI session via Corazon." This pattern is the rotation discipline for the credentials that genuinely need to exist.
- `~/ecodiaos/patterns/probe-all-env-files-not-just-dotenv.md` - sibling. When auditing where a credential is consumed, probe ALL env files (`.env.production`, `.env.local`, `.env.development`, `.env.staging`), not just `.env`.
- `~/ecodiaos/patterns/verify-empirically-not-by-log-tail.md` - same root rule. The rotation is verified by running-process state (smoke test, env probe), not by "I updated everything I remember."
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` - same root at the fork level. "I updated all the surfaces" is a self-claim; the artefact verification is each surface returning the new value.
- `~/ecodiaos/patterns/codify-at-the-moment-a-rule-is-stated-not-after.md` - the rule was stated 19:42 AEST 29 Apr 2026; this file is the same-evening codification per protocol.
