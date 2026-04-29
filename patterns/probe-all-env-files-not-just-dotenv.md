---
triggers: dotenv-probe, .env.production, .env.local, .env.development, env.staging, credential-probe, api-key-probe, env-recon, missing-key-probe, blocked-on-billing, blocked-on-tate-credential, all-env-files
---

# Probe ALL .env* files when looking for credentials, not just .env

## The rule

When you are recon-probing a codebase for a credential (API key, secret, token), do NOT conclude the credential is missing until you have read **every** `.env*` file in the project. The conventional layout in Vite / Next.js / Vercel / Capacitor projects parks production-only secrets in `.env.production`, not `.env`. Some projects also use `.env.local`, `.env.development`, `.env.staging`. There is no single canonical filename.

A "blocked on missing credential" / "blocked on Tate billing" conclusion drawn from a probe of `.env` alone is unreliable.

## Do

- `filesystem.listDir` the project root and enumerate every entry matching `.env*` (filename starts with `.env`).
- Read each one before concluding anything about credentials.
- If you find the credential in `.env.production` (or similar), note the exact filename in any handoff doc. Future-me searches by filename.
- After finding the key, store it in `kv_store` so future probes are O(1) instead of O(N codebases).

## Do not

- Probe `.env` once, get ENOENT, escalate to Tate as "blocked on credential rotation / billing / signup".
- Assume the absence of a `.env` file means there are no env files. Vite/Next projects often have `.env.production` and NO `.env`.
- Treat the prior fork's recon doc as authoritative when it says "blocked on X". Re-probe the recon premises before accepting them.

## Protocol when looking for an API key in a codebase

1. List the project root.
2. Identify every `.env*` filename.
3. Read each one. Look for keys matching the prefix you expect (`re_` for Resend, `sk_` for Stripe, etc.).
4. If still missing, only then escalate.

## Origin

2026-04-29. Two forks ran the Co-Exist Resend SMTP migration. The first (`fork_mojba1kx_b116e7`) probed `D:\.code\coexist\.env` on Corazon, got ENOENT, and concluded the Resend API key was missing AND the Resend account was payment-blocked on Mastercard 5428. Its handoff doc said "BLOCKED - Tate must update billing or pivot providers."

Tate flagged this 11:04 AEST: "should already have the resend api key in the .env." A second fork (`fork_mojcsuht_ebd0a4`) probed `D:\.code\coexist\.env.production` (the file that DOES exist) and found the key on the first read. Total time from spawn to "found": about 4 minutes.

The first fork's wrong conclusion cost ~45 minutes of recon work + an incorrect escalation to Tate that wasted his attention budget. The simplest fix: enumerate filenames before reading by name.

## Related

- `~/ecodiaos/patterns/forks-do-their-own-recon-do-not-probe-on-main.md` - the principle is correct (forks own their recon), the failure mode here is shallow probing.
- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` - a "blocked" conclusion needs to be load-bearing. If it's based on a single-filename probe, it isn't.
