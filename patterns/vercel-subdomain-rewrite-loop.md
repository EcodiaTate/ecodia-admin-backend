---
triggers: vercel, redirect, redirect loop, too many redirects, ERR_TOO_MANY_REDIRECTS, subdomain, code.ecodia.au, x-matched-path, middleware rewrite, 307 loop
---

# Vercel subdomain rewrite + page redirect = infinite loop

When a Next.js project on Vercel has BOTH (a) a middleware/rewrite that maps a subdomain to a specific app route, AND (b) that route's page returns a `redirect('/')` (or similar), the result is an infinite redirect loop.

## The signature

`curl -sI https://broken.example.com/` shows on every hop:
```
HTTP/2 307
location: /
x-matched-path: /some-route
server: Vercel
```

Key tells:
- Same `x-matched-path` on every hop (means middleware keeps rewriting the same way)
- Location is always `/` (the page's redirect target)
- Browser shows `ERR_TOO_MANY_REDIRECTS`

## Why it loops

1. Subdomain middleware in `middleware.ts` rewrites `broken.example.com/*` → `/some-route/*`
2. The `/some-route` page handler returns `redirect('/')`
3. Browser follows to `/` on the same host
4. Middleware rewrites `/` again → `/some-route`
5. Goto 2

The page redirect was probably written assuming the user hit `/some-route` directly on the apex domain, where redirect-to-root would land them on the homepage. On the rewritten subdomain, `/` IS `/some-route`.

## Diagnostic protocol

1. `curl -sI https://broken.tld/` — look for `x-matched-path` header. If it differs from the request path, middleware is rewriting.
2. Check Vercel project domains: `curl -H "Authorization: Bearer $VT" https://api.vercel.com/v9/projects/<project>/domains`
3. Read the project's `middleware.ts` for hostname-based rewrites.
4. Read the page handler at the matched path for `redirect()` / `permanentRedirect()` calls.

## Fix options (ranked)

1. **Remove the domain binding** (`DELETE /v9/projects/<project>/domains/<domain>`). Cleanest if the subdomain isn't actually intended to serve content. Returns 404 DEPLOYMENT_NOT_FOUND, no loop. DNS unaffected.
2. **Fix the page handler.** Remove the `redirect('/')` or make it conditional on hostname. Requires code change + deploy.
3. **Fix the middleware.** Don't rewrite if the request would loop. Requires code change + deploy.
4. **Vercel domain-level redirect** (`PATCH .../domains/<domain>` with `redirect: "https://target", redirectStatusCode: 308`). NOTE: Vercel rejects targets that are themselves on the same project ("Unable to redirect to X, because that domain is not added to the project" — misleading error). Useful only when redirecting to a domain on a DIFFERENT Vercel project or external host.

## Vercel API quirks worth remembering

- The `redirect` field on a domain only works for targets that are NOT bound to the same project. The error message is misleading — it says "not added to the project" when the truth is "this combination isn't allowed."
- `DELETE /v9/projects/<project>/domains/<domain>` returns `{}` on success and detaches the domain. DNS records are untouched.
- The `x-matched-path` response header is the single most useful diagnostic for Vercel routing weirdness. Always check it first.

## Origin

Apr 27 2026, fork_mogooaed_5503d9. Tate hit `https://code.ecodia.au/` in browser at 14:13 AEST, got too-many-redirects. The `code.ecodia.au` subdomain was bound to the `ecodia-site` Next.js project. Project middleware mapped `code.ecodia.au/*` → `/code/*`, and the `/code` page returned `redirect('/')`. Resolved by deleting the domain binding from the project. Future fix if `code.ecodia.au` is ever needed for real: either rebind to a different project, or fix the `/code` page handler in the ecodia-site repo to not redirect when the host is `code.ecodia.au`.
