---
triggers: coexist, microsoft-graph, graph-api, entra, azure-ad, app-registration, client_secret, tenant_id, excel-sync, m365, microsoft365, edge-function-coexist
class: programmatic-required
owner: ecodiaos
---

# creds.coexist_graph_api

Microsoft Graph API app-only credentials for Co-Exist's Microsoft Entra (Azure AD) tenant. Used by the Co-Exist excel-sync Edge Function to read/write the registration spreadsheet on cron without a human in the loop.

## Source

Co-Exist's Entra tenant > App registrations > {app_name} > Certificates & secrets. The app registration is named per the `app_name` field.

## Shape

object `{tenant_id, client_id, client_secret, app_name}`

## Used by

- `~/ecodiaos/clients/coexist.md` (excel-sync deploy) - secrets injected into Edge Function env (Deno.env), NOT in code
- The deployed Co-Exist Edge Function `excel-sync`
- Any future Co-Exist Graph API integration (mailbox reads, calendar, etc.)

## Replaceable by macro?

No. Edge Function runs on Supabase cron, no human GUI involved. This is exactly the case where API keys are correct (server-to-server, headless).

## Rotation

Per-vendor-policy. Entra client secrets default to a 24-month maximum lifetime; the Co-Exist Entra admin sets the actual expiry on creation.

## Restoration if lost

1. Co-Exist Entra admin (Charlie or delegated admin) navigates to Entra > App registrations > {app_name} > Certificates & secrets.
2. Create new client secret > copy the VALUE field (only visible at creation time).
3. UPSERT `creds.coexist_graph_api.client_secret` with the new value.
4. Redeploy the Edge Function so the new secret is injected into env: `npx supabase functions deploy excel-sync --project-ref tjutlbzekfouwsiaplbr`.

## Failure mode if missing

Excel-sync Edge Function fails with `AADSTS7000215: Invalid client secret` or similar. Spreadsheets stop syncing into Co-Exist's app database. Forms-driven user registrations stall.

## Doctrine

This is a programmatic-required credential and is correctly held in kv_store. Do NOT try to replace this with a GUI-macro - the doctrine in `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md` carves out exactly this case (server-to-server cron with no human in loop) as the legitimate API-key territory.
