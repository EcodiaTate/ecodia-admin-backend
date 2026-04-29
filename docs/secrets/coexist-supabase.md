---
triggers: coexist, supabase-coexist, coexist-db, anon-key-coexist, service-role-coexist, db_password-coexist, coexist-supabase-url, smoke-tests, edge-function-coexist
class: programmatic-required
owner: ecodiaos
---

# creds.coexist_supabase

Co-Exist Supabase project credentials - URL, anon key, service role key, DB password. All four needed for direct DB access, Edge Function development, and smoke tests against Co-Exist data.

## Source

Co-Exist Supabase dashboard > Settings > API and Settings > Database.

## Shape

object `{url, anon_key, service_role_key, db_password}`

## Used by

- Co-Exist excel-sync Edge Function (uses anon_key in Deno code, service_role_key for admin operations)
- Smoke tests against Co-Exist DB (`creds.coexist` app login + this row's URL)
- `~/ecodiaos/clients/coexist.md`
- Direct `psql` connections using `db_password`

## Replaceable by macro?

No. This is server-to-server credential territory.

## Rotation

Never automatically. Supabase doesn't rotate API keys. DB password is rotatable from dashboard but causes brief downtime; rebound only on incident.

## Restoration if lost

1. Co-Exist Supabase dashboard > Settings > API > Reveal service role key (and anon key).
2. Settings > Database > Reset database password (only if rotating).
3. UPSERT relevant fields in `creds.coexist_supabase`.

## Failure mode if missing

- All Co-Exist DB operations from VPS fail.
- Edge Function deploy is unaffected (deploys use `creds.supabase_access_token`); Edge Function RUNTIME fails because env vars don't get injected.
- Smoke tests fail at DB queries.

## Sensitivity

`service_role_key` bypasses RLS - it's the admin key. Treat with maximum care; never commit to source, never log to stdout, never include in screenshots.
