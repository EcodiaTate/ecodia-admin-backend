---
triggers: bitbucket, atlassian, ordit, fireauditors, fireauditors1, git push, git remote, bitbucket api, x-bitbucket-api-token-auth, bitbucket-pr, pull-request, ATATT, api-token
class: programmatic-required
owner: tate
---

# creds.bitbucket_api_token + creds.bitbucket_account_email

Atlassian API key (single key, two consumption contexts) used for ALL Bitbucket interactions. Without it, Ordit work blocks (the Ordit repo lives at `bitbucket.org/fireauditors1/be`) and any push from VPS fails.

| Key | Shape | What it is |
|---|---|---|
| `creds.bitbucket_api_token` | scalar string, format `ATATT...` | The Atlassian API key itself |
| `creds.bitbucket_account_email` | scalar string, `code@ecodia.au` | Atlassian account the key is issued under (paired with the key for REST auth) |

## Source

id.atlassian.com > Security > API tokens.

**Critical: this is an API KEY, not a personal access token.** Atlassian deprecated PATs in 2026. If you read older docs referencing "rotate the personal access token," that language is stale.

## Shape

Two paired scalars (NOT a single object).

## Used by

Two distinct auth contexts, same key, different username:

1. **Git HTTPS remote (push/pull/clone):**
   ```
   https://x-bitbucket-api-token-auth:<API_KEY>@bitbucket.org/<workspace>/<repo>.git
   ```
   Username is the literal magic string `x-bitbucket-api-token-auth`. NOT the email.

2. **Bitbucket REST API (`api.bitbucket.org/2.0/...`):**
   ```
   curl -u code@ecodia.au:<API_KEY> https://api.bitbucket.org/2.0/...
   ```
   Username IS the Atlassian account email (`creds.bitbucket_account_email`). Using the magic git username here returns HTTP 401.

Consumers:
- `~/ecodiaos/clients/ordit.md` (Ordit auth doctrine; canonical reference for the two-context split)
- `~/ecodiaos/patterns/ordit-prepush-pipeline.md`
- All `git push` operations against `bitbucket.org/fireauditors1/*`
- All REST calls (PR comments, branch list, diff fetch, comment delete)

## Replaceable by macro?

Partial. PR review/comment workflows ARE doable through Tate's Chrome on Corazon (drive bitbucket.org). But VPS-side `git push` from automation requires the token - there is no SSH keypair fallback configured for `fireauditors1`.

## Rotation

On-leak-only. Atlassian API keys do not auto-expire.

## Restoration if lost

1. Tate logs into id.atlassian.com.
2. Security > API tokens > Create.
3. UPSERT `creds.bitbucket_api_token` with new value.
4. Re-embed in any cached git remote URLs:
   ```
   git remote set-url origin https://x-bitbucket-api-token-auth:<NEW_KEY>@bitbucket.org/<ws>/<repo>.git
   ```

## Failure mode if missing

- Git push to `fireauditors1/*` fails (HTTP 403 / 401).
- REST API calls (PR comments, etc.) fail with HTTP 401.
- All Ordit-PR work blocks until rebound.

## Drift note

Status_board / older notes occasionally reference "Atlassian API token expired - rotate personal access token." Stale language. PATs no longer exist on Atlassian. The thing in `creds.bitbucket_api_token` IS the API key.

If push is failing while the REST API works, suspect SCOPE drift (the key has read but not write scope). Tate must rebuild the key with both Repository Read and Repository Write enabled.
