---
triggers: vercel-env-baked, vite-build-time-inline, build-time-baked-in, hardcoded-url, redirectTo, prod-bug-source-fine, source-looks-correct, dist-bundle-grep, deployed-bundle-grep, stale-env-baked, vite-app-url, NEXT_PUBLIC_, VITE_APP_URL, vercel-rebuild, env-deletion, env-update-redeploy, password-reset-bug, redirect-url-wrong
---

# When a prod bug seems impossible to explain from source code, audit Vercel env vars - Vite/Next inline them at build time and they go stale silently

## TOP-LINE INVARIANT (29 Apr 2026, Coexist password reset URL bug)

**Vite (and Next.js public env vars) inline `process.env.VITE_*` and `process.env.NEXT_PUBLIC_*` AT BUILD TIME.** Whatever value the env var has when `vite build` runs gets BAKED INTO the JS bundle as a string literal. Source code can read clean (`${import.meta.env.VITE_APP_URL || window.location.origin}/path`) and yet the deployed bundle holds a stale, wrong, or never-updated value. The fallback (`||`) only runs at RUNTIME - if Vite at build time saw VITE_APP_URL = "stale-string", the bundle has `"stale-string"` literally. The fallback never fires.

**The protocol when prod behaviour disagrees with source:**

1. **Don't trust the source repo.** It was right when committed. Vercel may have inlined a stale value at build time.
2. **Inspect the deployed bundle directly.** `curl -sL https://prod-domain.com -A "Mozilla/5.0"` to grab the home page, find the JS chunk URL, fetch the chunk, grep for the suspicious string (e.g. `redirectTo`, `apiBase`, `siteUrl`).
3. **If the bundle has a stale literal, the env var is the cause.** Audit Vercel project env vars: `curl -s "https://api.vercel.com/v9/projects/{project_id}/env?decrypt=true" -H "Authorization: Bearer $VERCEL_API_TOKEN"`. Look for VITE_*, NEXT_PUBLIC_*, anything that gets inlined.
4. **Fix path is delete or update + redeploy.** Deleting (when the source has a sensible runtime fallback) is often cleaner than setting a "correct" value, because you avoid future stale-fallback drift.
5. **Trigger a fresh build.** `mcp__business-tools__vercel_trigger_deploy` or git-push a no-op commit. Wait for READY. Re-curl the bundle to confirm the literal is gone.

## Why

29 Apr 2026 ~10:35 AEST: Tate flagged "Supabase password reset email link sends to app.coexistaus.org/# how do i fix that. The actual url is /reset-password."

I spent ~25 min hypothesising about Supabase Auth config (URI_ALLOW_LIST, mailer template, generate_link semantics, body-vs-query-param redirect_to). I correctly traced that the SDK passes redirect_to as a query param. I generated empirical test emails - one with redirect_to in body (failed), one as query param (worked, link correct).

That diagnostic established that Supabase Auth was working correctly given the right input. Conclusion: production app must be sending the wrong input.

Source code at `~/workspaces/coexist/src/hooks/use-auth.ts:659`:
```js
redirectTo: `${import.meta.env.VITE_APP_URL || window.location.origin}/reset-password`,
```

That looks fine. Origin fallback should kick in if VITE_APP_URL is unset.

Then I curled the deployed bundle and grep'd for `resetPasswordForEmail`. Found:
```js
redirectTo: `coexist-alpha.vercel.app/reset-password`
```

**The bundle had a HARDCODED literal** - no template, no fallback, no origin. Why? Because at build time, Vite saw `VITE_APP_URL=coexist-alpha.vercel.app` and inlined it as the entire literal string (replacing the template expression's first part). The `|| window.location.origin` fallback never got a chance to run because the value was a non-empty truthy string at build.

The fix took 2 minutes once the diagnostic was right: deleted VITE_APP_URL from Vercel coexist project, triggered redeploy, verified new bundle had `redirectTo: ${window.location.origin}/reset-password` instead.

The 25 min wasted was time spent assuming "if source is correct, deploy is correct" - which is WRONG for any framework that does build-time env inlining (Vite, Next.js public vars, Webpack DefinePlugin, etc).

## Do

- For ANY production bug where source code seems impossible to explain, the FIRST diagnostic step is "fetch the deployed bundle and grep for the suspicious literal." Skip the source-reading-loop. The bundle is ground truth.
- Treat every `import.meta.env.VITE_*` reference and `process.env.NEXT_PUBLIC_*` reference as a build-time substitution that may or may not match the source's runtime intent.
- When deleting a "potentially stale" env var that has a runtime fallback, prefer DELETION over correcting the value. Future-proofs against the same bug.
- Document EVERY env var that exists on Vercel and its expected value alongside the project, so audit-time is fast.

## Do NOT

- Do NOT spend time debugging Supabase Auth / Stripe API / external service config when the suspect string is a literal in the bundle.
- Do NOT assume Vite "smart fallbacks" based on `||` work at deploy time. They only work if the LEFT operand evaluated to falsy at BUILD time.
- Do NOT update env vars without redeploying. The change takes effect on the NEXT build, not the existing deployment.
- Do NOT delete env vars without checking other consumers. `VITE_APP_URL` may be used in 5 places; deletion changes all of them simultaneously.

## Protocol when applying

```
Prod behaviour disagrees with source:
  1. curl the prod URL, find the JS chunk paths
  2. fetch the chunk(s), grep for the literal that's wrong
  3. if found as a hardcoded literal:
     a. it came from a build-time env inlining
     b. find the matching env var on Vercel
     c. delete or update it
     d. trigger redeploy, wait for READY
     e. re-curl bundle, verify literal is gone
  4. if NOT found as hardcoded literal:
     this isn't a build-env bug - look elsewhere (config, RLS, service-side)
```

Total time for this protocol: ~5 min once you know to start with bundle inspection. Without this discipline: 25+ min of hypothesis-testing the wrong layer.

## Origin event

29 Apr 2026 10:35-11:01 AEST. Coexist password reset emails landing at `app.coexistaus.org/#` instead of `app.coexistaus.org/reset-password`. Diagnosed root cause as `VITE_APP_URL=coexist-alpha.vercel.app` (stale Vercel preview URL, missing protocol) baked into the build by Vite at deploy time. Fix: deleted env var from Vercel project (`mcp__business-tools__vercel_*` API), triggered redeploy, verified new bundle uses runtime `window.location.origin` fallback. Episode in Neo4j + Co-Exist root status_board row context.

## Cross-references

- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` (Pattern 3679) - this fix took the route-around path correctly: "agent CDP debugging blocked one path, deleted-env-var path was always available."
- `~/ecodiaos/patterns/forks-self-assessment-is-input-not-substitute.md` (Pattern 3678) - if I'd inspected the deployed bundle at v2/v2.1 ship time, I'd have caught the stale env there too. Bundle inspection is part of visual-verify.
- `~/ecodiaos/patterns/no-placeholders-no-coming-soon-on-shipped-features.md` - real domain literals in bundles count as the same class of "what's actually rendered/sent" as on-screen placeholders.
