---
triggers: deploy, vercel, deployment, fork-deploy, push, git-push, build-failure, deploy-verify, fork-report, post-deploy, READY, ERROR, build-error, half-finished, dies-after-push, deployment-pipeline, deploy-loop, ship-broken, broken-deploy
---

# A fork that pushes is not a fork that finished. Verify deploy READY before [FORK_REPORT].

## TOP-LINE INVARIANT

**`git push` is not the deliverable. A green production deploy is the deliverable.** Any Factory session or fork that pushes code to a Vercel-linked repo MUST poll the deploy state until READY before reporting `done`. If the deploy is ERROR, the session is responsible for fixing it - not for handing back a broken state with a "I pushed it" report.

## The failure mode this prevents

Half-finished work that looks finished. The fork hits its end-of-task milestone, runs `git push`, says "deployed" in the report, and exits. The push triggered a Vercel build that failed on TypeScript errors / missing env / build command mismatch / etc. The site is broken in production. I (the conductor) read the [FORK_REPORT], think the work is done, move on. The breakage is discovered later by Tate, by a client, or by the next fork that tries to build on top of the broken main branch. Trust gets eroded for a class of failure that is mechanically preventable.

## The mechanical fix - mandatory in every brief that touches a deployable repo

Every brief I dispatch to a fork or Factory session against a Vercel-linked repo includes this acceptance gate:

```
DEPLOY VERIFY (non-negotiable):
After your final `git push`:
  1. Identify the Vercel project for this repo (read .vercel/project.json or vercel ls).
  2. Poll the latest deployment for that project until state is READY or ERROR.
  3. If READY: curl the production URL, confirm HTTP 200 on /, take a Puppeteer screenshot of at least 3 routes.
  4. If ERROR: pull buildLogs, fix, push again. Repeat. Max 5 deploy attempts.
  5. [FORK_REPORT] is only `done` when state == READY. Otherwise the report is `blocked` with full error context.
```

This goes in EVERY brief that hits a deployable repo. The brief-skeleton template in `brief-names-the-product-not-the-immediate-task.md` includes this as a required section.

## Do
- Treat `git push` as step N-1, never as step N. Step N is "deploy READY confirmed."
- Fix the build errors in the same session that introduced them. Do not return broken code to me.
- Cap deploy retries at 5 to prevent infinite-loop forks. After 5, return `blocked` with full logs and let the conductor decide.
- Use `mcp__business-tools__vercel_list_deployments` + `vercel_get_deployment` for state polling - they're MCP tools available to forks.
- Smoke-test at least 3 routes with curl + Puppeteer before declaring done. The build can be green and the app still 500 at runtime.

## Do NOT
- Report `done` after `git push` without checking deploy state. Ever.
- Assume "the build was green locally" means production will deploy. Vercel's build env differs (Node version, env vars, install cache) - confirm.
- Push a fix and walk away mid-deploy. The deploy can take 60-120 seconds; if you push and exit, the conductor sees a stale state.
- Hand back a `done` report with a [FORK_REPORT] that doesn't include the production URL and a deploy state.

## Verification (conductor-side)

After every fork that touches a deployable repo, before archiving the work:
1. Read [FORK_REPORT]. If it says `done`, look for the deploy state field.
2. If deploy state is missing or not READY, the fork didn't finish. Re-dispatch with the build logs.
3. Hit the production URL myself. If it 500s or returns garbage, the fork didn't finish.

## Origin

2026-04-28 12:50 AEST. The chambers app fork (`fork_moi08v5y_c80250`) pushed commit `6f73ea8` to `chambers-frontend`. The deploy failed (`Command "npm run build" exited with 2` - 13 TypeScript errors across EventDetail/Events/Home/Members on @tanstack/react-query v5 `loading` -> `isLoading` and undefined-array-access). The fork did not poll Vercel for deploy state, did not see the failure, did not fix it. Tate flagged it: "when a deployment fails from a fork session, it doesn't follow up, need to fix that since it can't just be dying as soon as it pushes, half finishing the job if the deployment fails. Learn from all this as well." Doctrine inserted into the running fork via `send_message`, codified here for every future dispatch.

## Related

- `brief-names-the-product-not-the-immediate-task.md` (brief skeleton must include the deploy-verify gate)
- `project-naming-mirrors-repo-name.md` (companion failure: orphaned `fe` Vercel project from same fork)
- `cancel-stale-schedules-when-work-resolves-early.md` (general anti-symbolic-logging discipline)
