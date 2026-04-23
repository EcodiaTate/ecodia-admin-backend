---
triggers: e2e, end-to-end, test:e2e, jest-e2e, test coverage, auth-cognito.e2e-spec, shipped-but-inert, test harness, ordit e2e, client test infra
---

# Verify the client's e2e harness actually loads before claiming e2e coverage

Adding a `*.e2e-spec.ts` file to a client PR does not mean the PR is e2e-validated. The file has to actually execute. Many client repos have an e2e script (`yarn test:e2e`, `npm run test:e2e`) that has never run in CI and is broken at config level. Your test file ships as decoration: cannot execute, cannot validate, cannot regress.

This rule applies to every client backend where we add or modify a `*.e2e-spec.ts` / integration spec.

## The rule

Before any push that adds or modifies an e2e spec, run the client's e2e command locally and confirm the suite actually enumerates and loads its tests. If it fails at the harness layer (module resolution, missing config, broken jest config, path alias issue), the test you're adding is shipped-but-inert.

Do NOT represent the PR as "e2e-validated" in the description, in commit messages, or to the client reviewer. State truthfully:
- "Unit tests pass (CI runs `yarn test`)."
- "E2E spec added for when client chooses to wire up their e2e harness. Not currently executed in CI."

## Protocol (run before push)

Step 1. Run the client's e2e entrypoint locally:
```bash
# NestJS example
yarn test:e2e  # or: npx jest --config ./test/jest-e2e.json

# Generic Node
npm run test:e2e

# List-only variant (fastest sanity check)
npx jest --config ./test/jest-e2e.json --listTests
```

Step 2. Read the output. Three outcomes:

| Outcome | Meaning | Action |
|---|---|---|
| Tests enumerate + execute + pass | Harness works, tests pass | Normal. PR can claim e2e coverage. |
| Tests enumerate but individual tests fail | Harness works, your code has bugs OR environment not configured | Fix the bugs, or document the env gap and skip-guard the tests |
| Suite fails to load ("Cannot find module X", "Cannot find preset Y", ts-jest transform error) | Harness is broken at config level | Shipped-but-inert. Do not claim e2e coverage. See options below. |

Step 3. If the harness is broken, check the client's CI config to see if they actually run e2e at all:
```bash
cat bitbucket-pipelines.yml | grep test
cat .github/workflows/*.yml 2>/dev/null | grep test
```

If their CI only runs `yarn test` (unit) and not `yarn test:e2e`, the harness has likely been broken for a long time and no one has noticed. Do not flip their pipeline to add `yarn test:e2e` - that is an infrastructure change and violates `client-push-pre-submission-pipeline.md` Step 4.

Step 4. Decide the ship posture for your e2e spec:

| Option | When | Effect |
|---|---|---|
| Leave the spec in place | Default when the harness is broken. Spec costs nothing since CI never runs it. | Client can pick it up for free when they fix their harness. |
| Pull the spec out of the PR | If shipping a dead file would confuse reviewers, or if the PR reviewer has asked about e2e coverage | PR stays narrow. Re-propose when harness exists. |
| Open separate PR to fix harness | Only with Tate sign-off + explicit client request. This is an infrastructure change, not a feature change. | Needs rollout plan per `client-push-pre-submission-pipeline.md` Step 4. |

Default is "leave the spec in place + do not claim coverage."

## Internal gate option (patch locally, do not push)

If we want to actually exercise the e2e spec for our own pre-push validation without modifying the client's config:

1. Patch their jest-e2e config locally with whatever the harness needs (usually `moduleNameMapper` for path aliases).
2. Run `yarn test:e2e` and capture the result.
3. `git checkout test/jest-e2e.json` (or equivalent) to discard the patch before pushing.

Cost: minor git hygiene. Benefit: real local validation. Worth doing when we've changed anything in the spec's direct dependency tree (auth, users, whatever the spec exercises).

## Do

- Run `yarn test:e2e` (or equivalent) locally BEFORE claiming e2e coverage on any client PR.
- State ship posture truthfully: "unit tests pass, e2e spec added for future harness use" when the harness is broken.
- Document the finding in `~/ecodiaos/clients/<slug>.md` so future sessions know.
- Add the harness-load check to the pre-push gauntlet for that client.

## Do not

- Claim e2e coverage in a PR description or commit message when the harness does not load.
- Ship a jest/pytest/mocha config fix inline with a feature PR. That is an infrastructure change.
- Assume `yarn test:e2e` passing means e2e runs in CI. Check their pipeline config.
- Assume e2e spec exists = e2e runs. Most client repos have aspirational e2e specs from years ago.

## Verification

After push, cross-check: did the PR reviewer interpret the spec as active coverage? If a reviewer says "nice, e2e tests," correct them: "Thanks - note the spec ships against your existing e2e harness, which currently isn't part of your PR CI. Wanted to flag so you're not assuming it's running on green."

## Origin

Apr 23 2026. Ordit PR 212 (feat/cognito-be-integration). Added `test/auth-cognito.e2e-spec.ts` (196 lines) with full Cognito + legacy-auth integration flows. Post-push attempt to run locally revealed: Ordit's `test/jest-e2e.json` has no `moduleNameMapper`. Their `tsconfig.json` declares `paths: { "@/*": ["src/*"] }`, but `ts-jest` does not honour tsconfig paths without explicit jest mapping. Result: BOTH the pre-existing `test/app.e2e-spec.ts` AND our added `auth-cognito.e2e-spec.ts` fail to load with:

```
Cannot find module '@/utils/convert-to-plural' from '../src/base/base.service.ts'
```

Their `bitbucket-pipelines.yml` only runs `yarn test` (unit) on PR validation, never `yarn test:e2e`. So the harness has been broken for the entire lifetime of the `@/*` refactor and nobody - Eugene included - has noticed.

Implication: our `auth-cognito.e2e-spec.ts` on PR 212 is shipped-but-inert. It cannot execute, cannot validate, cannot regress anything. We must not represent PR 212 as e2e-validated. The spec costs nothing in their CI and they pick it up for free when they choose to wire up e2e later. Full write-up in `~/ecodiaos/clients/ordit.md` 2026-04-23 section.

The generalised rule (this file): every client e2e harness has to be verified loading before we claim coverage. Fresh sessions should grep this file on triggers: `e2e`, `test:e2e`, `auth-cognito.e2e-spec`, `shipped-but-inert`. See also `client-push-pre-submission-pipeline.md` for the broader pre-push gauntlet.
