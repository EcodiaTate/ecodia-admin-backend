---
triggers: xero, xero-oauth, xero-callback, redirect-uri, oauth-404, xero-tokens, bank-feeds, bookkeeping-pipeline, finance-callback, oauth-silent-fail
---

# Xero OAuth fails silently when redirect URI mismatches mounted route

## The rule

If `xero_tokens` is empty after a "successful" OAuth click, the first thing to check is whether `XERO_REDIRECT_URI` in `.env` matches the actual mounted callback route. A mismatch makes Xero send the user back to a non-existent URL — they see a 404 page (or a generic Xero "redirect failed" screen, depending on browser) and the OAuth state row is consumed but no token exchange happens. Repeated reauthorisation attempts fail the same way, and from inside the app it just looks like "Xero never connects."

## Do

- Before debugging OAuth from scratch, check `.env XERO_REDIRECT_URI` and grep `app.js` for which path the Xero `publicRouter` actually mounts at. They must match. They must also match what's registered in the Xero developer console under "Allowed redirect URIs."
- After any rename/refactor of route prefixes, re-check the .env redirect URI.
- The Xero dev console allows multiple redirect URIs - register all of them you might use (dev, staging, prod, alternative paths) so a single env edit is enough to switch.

## Do not

- Don't dispatch a Factory job to "fix Xero" without first confirming the redirect URI alignment. The OAuth code in xeroService is usually fine - the bug is config drift.
- Don't try to reauthorise repeatedly from the frontend - it just creates dead `xero.oauth_state.*` rows in kv_store. Each click consumes a fresh state but the callback never lands.
- Don't assume the Xero MCP returning `{"error":"Xero not connected","authorize_url":"/api/xero/connect"}` means the app needs a fresh authorize click. It might mean the LAST authorize click landed on a 404 because of the mismatch.

## How to diagnose in 60 seconds

```bash
# 1. Token state
psql -c "SELECT COUNT(*) FROM xero_tokens"   # 0 = disconnected

# 2. Redirect URI
grep XERO_REDIRECT_URI /home/tate/ecodiaos/.env

# 3. Actual mounted route
grep -n "xero" /home/tate/ecodiaos/src/app.js | grep "use\|app.use"

# 4. Compare the path component of step 2 against the prefix in step 3 + the route in src/routes/xero.js publicRouter (look for router.get('/callback', ...))
```

If they don't match: that's the bug.

## How to fix

Two valid paths, pick by where the source of truth should live:

**Path A (config-side):** Change `.env` redirect URI to match the mounted route. Update Xero developer console to include the new URI in allowed redirects. Reauthorise.

**Path B (code-side):** Add a route alias so the legacy redirect URI also lands on the publicRouter. In `app.js`:
```js
app.use('/api/xero', xeroRoutes.publicRouter)
app.use('/api/xero', xeroRoutes)
app.use('/api/finance/xero', xeroRoutes.publicRouter)  // alias for legacy redirect URI
```
Restart `ecodia-api`. Reauthorise.

Pick A if you want one canonical URI. Pick B if you want backward compatibility with anything that already uses the legacy URI.

## Verification after fix

```sql
SELECT * FROM xero_tokens;  -- should have 1 row, expires_at in the future
```
And:
```bash
curl -H "Authorization: Bearer $MCP_INTERNAL_TOKEN" http://localhost:3001/api/xero/status
# Expected: {"connected":true,"expires_at":"...","tenant_id":"..."}
```

## Origin

2026-04-27, 08:30 AEST. Tate asked "get the Xero feeds working - we still haven't had that working properly." Investigation showed `xero_tokens` empty, MCP returned 503 with authorize_url. Reading `src/routes/xero.js` + `src/app.js` + `.env` revealed `.env XERO_REDIRECT_URI=https://api.admin.ecodia.au/api/finance/xero/callback` but `app.use('/api/xero', xeroRoutes.publicRouter)` mounts the callback at `/api/xero/callback`. There is no `/api/finance/xero` route. Every reauth attempt has been silently 404ing on callback. SMS to Tate to pick A or B. Pattern written before the fix lands so the diagnosis path is preserved.
