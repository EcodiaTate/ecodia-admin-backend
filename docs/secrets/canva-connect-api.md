---
triggers: canva, canva-connect, design-automation, oauth-canva, client_id-canva, client_secret-canva, canva-integration, canva-api
class: programmatic-required
owner: ecodiaos
---

# creds.canva.connect_api

Canva Connect API OAuth credentials. Provisioned ahead of a forthcoming design-automation integration; no live consumer yet. The Canva editor itself is GUI-driveable, but a long-running automation pipeline benefits from the API.

## Source

canva.com/developers > Apps > {integration_name} > OAuth.

## Shape

object `{client_id, client_secret, redirect_uri, scopes, integration_name, account, type, review_status, submitted_at, created_at}`

The `review_status` field tracks Canva's app-review workflow (Canva requires apps to be reviewed before going public; private apps work for internal use without review).

## Used by

- Currently no script direct reference. Row is provisioned ahead of integration build.
- Future design-automation tooling (template fills, brand asset generation, etc.)

## Replaceable by macro?

The Canva editor IS GUI-driveable through Tate's Chrome on Corazon. Whether to use the macro path or the API depends on the workflow:

- One-off design tweak? Macro.
- Cron-based template-fill pipeline? API (this row).
- Bulk batch operation? API.

Re-evaluate per-workflow per `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`.

## Rotation

Rebound only on incident. The `review_status` field can change as Canva re-reviews the integration; doesn't require credential rotation.

## Restoration if lost

1. canva.com developer console > Apps > {integration_name} > OAuth > Regenerate.
2. UPSERT `client_secret` (and `client_id` if it changed - usually doesn't).

## Failure mode if missing

Canva integration cannot authenticate. No live consumers today, so impact is "delayed start."
