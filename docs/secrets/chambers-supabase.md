---
triggers: chambers, chambers-supabase, federation, multi-tenant-chambers, anon-key-chambers, service-role-chambers, db_pass-chambers, chambers-db, chambers_supabase_dbpass
class: programmatic-required
owner: ecodiaos
---

# creds.chambers_supabase + creds.chambers_supabase_dbpass

Chambers federation Supabase project credentials. Provisioned 28 Apr 2026 ahead of forthcoming multi-tenant work; no live consumer yet.

| Key | Shape | What it holds |
|---|---|---|
| `creds.chambers_supabase` | object | `url, db_url, db_host, anon_key, service_role_key, project_ref, org_id, region, name, status, created_at, provisioned_by` |
| `creds.chambers_supabase_dbpass` | scalar string, 37 chars | The DB password (NOT held in the object above) |

## Source

Chambers Supabase dashboard. The DB password was generated when the project was created; the scalar mirror exists because the object schema didn't include `db_password` at provisioning time.

## Shape

One object row, one scalar row. See table above.

## Used by

- Forthcoming Chambers federation work (no current script direct reference)
- Reference for multi-tenant pattern documentation (`~/ecodiaos/patterns/multi-tenant-brief-must-enumerate-customisation-surface.md` describes the federation architecture; this row holds the project-side credentials)

## Replaceable by macro?

No. Server-to-server credential.

## Rotation

Never automatically. Rebound only on incident.

## Restoration if lost

1. Chambers Supabase dashboard > Settings > API > Reveal keys.
2. Settings > Database > Reset password (only if rotating).
3. UPSERT relevant fields.

## Drift note

The scalar `creds.chambers_supabase_dbpass` and the object `creds.chambers_supabase` together hold related data, but the object is missing a `db_password` field. Two consolidation paths in the future migration:

1. Add `db_password` field to the object, deprecate the scalar.
2. Keep scalar separate (matches the `creds.asc_api_*` triple convention - several scalars for one logical credential set).

Recommendation: option 1 (single source of truth per logical credential cluster). NEEDS-FOLLOW-UP-FORK.

## Failure mode if missing

Chambers federation work blocks. Today there's no live consumer so the impact is "delayed start" not "outage."
