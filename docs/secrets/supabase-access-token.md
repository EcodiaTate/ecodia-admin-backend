---
triggers: supabase, supabase-access-token, edge-function-deploy, supabase-functions-deploy, sbp_, supabase-management, supabase-cli, npx-supabase, project-ref
class: programmatic-required
owner: tate
---

# creds.supabase_access_token

Supabase Management API personal access token (`sbp_...`). Used for Edge Function deploys and any Supabase CLI / Management API operation that needs auth.

## Source

supabase.com/dashboard/account/tokens

## Shape

scalar string, 46 chars, format `sbp_...`.

## Used by

- `~/ecodiaos/clients/coexist.md` Edge Function deploy step:
  ```bash
  cd /home/tate/workspaces/coexist && SUPABASE_ACCESS_TOKEN=<creds.supabase_access_token> npx supabase functions deploy excel-sync --project-ref tjutlbzekfouwsiaplbr --no-verify-jwt
  ```
- `~/ecodiaos/clients/coexist-resend-smtp-setup-2026-04-29.md`
- Any future `supabase functions deploy` against any project-ref.

## Replaceable by macro?

Edge Function deploys ARE GUI-doable via the Supabase dashboard, but the CLI path is the primary release-driver mechanism (faster, scriptable, lockstep with git pushes). Macro is a fallback only.

## Rotation

On-leak-only. Supabase PATs do not auto-expire.

## Restoration if lost

1. Tate logs into supabase.com/dashboard/account/tokens.
2. Generate new token > scope: full account.
3. UPSERT `creds.supabase_access_token`.

Old token can be revoked from the same page once the new one is verified working.

## Failure mode if missing

`npx supabase functions deploy` errors with auth failure. Edge Function ships block until rebound.
