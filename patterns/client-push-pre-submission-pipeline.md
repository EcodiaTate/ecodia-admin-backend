---
triggers: client-push, bitbucket-push, ordit-push, fireauditors, pr-submission, push-to-client, factory-client-dispatch, pipeline-change, migration-change, bitbucket-pipelines, prisma-migrate, db-push, infra-change, staged-rollout
---

# Pre-submission pipeline before any push to a client repo

Every push to a client repo goes through an explicit pre-submission pipeline. Writing the code is not the last step. Running the pipeline is. A clean diff that does exactly what the ticket says and nothing more is the only kind of diff that ships.

The pipeline is mandatory for: Ordit (`fireauditors1/be`, `fireauditors1/fe`), Co-Exist, any future external-reviewer codebase. Optional but encouraged for Ecodia-internal repos.

## The pipeline (run before every `git push origin <branch>`)

Run these in order. If any step fails, do not push. Fix the branch first.

### Step 1 — Scope gate: `git diff --stat origin/<base>..HEAD`

List every changed file. For each file ask, out loud:

- Is this file explicitly in scope of the stated ticket / PR comment / client instruction?
- If yes: name the instruction (comment ID, ticket number, message snippet, or "implied by ticket title because X").
- If no justification exists: **the change does not ship.** Revert it on the branch.

"It seemed like a good idea while I was in there" is a failure mode. Clients experience unscoped changes as hostile, even when they're technically improvements.

### Step 2 — Risk classification on every changed file

Tag each changed file with one of:

| Tag | Examples | Action |
|---|---|---|
| `code` | `.ts`, `.js`, `.py`, business logic | Normal review. OK to ship in a feature PR. |
| `config` | `.env.example`, app config, feature flags | OK to ship in a feature PR if directly required. Flag it in the PR description. |
| `test` | `*.spec.ts`, `*.test.ts` | OK. Encouraged. |
| `docs` | `README.md`, inline docstrings | OK if directly related to the shipped code. Avoid drive-by edits. |
| `pipeline` | `bitbucket-pipelines.yml`, `.github/workflows/*`, `Dockerfile`, CI config | **DOES NOT SHIP IN A FEATURE PR.** Carve off into a separate change with a rollout plan, even if a reviewer asked for it inline on the same PR. |
| `db-schema` | `prisma/schema.prisma`, SQL migrations, baseline migrations | Allowed **only if** the ticket is explicitly a schema change. Otherwise carve off. Every schema change comes with a rollout plan (Step 4). |
| `infra` | Terraform, IaC, deploy scripts, k8s manifests | Does not ship in a feature PR. Separate change. |

Anything tagged `pipeline`, `db-schema`, or `infra` triggers Step 4.

### Step 3 — Provenance check for surprising changes

For each non-trivial change that a reviewer might flag as "wait, why is this here?", write a one-line note:

> `file.path` — requested by `<reviewer> comment #<id>` / `<ticket>` / `implied by <instruction>`

Keep this list. If the PR description doesn't already cover it, paste it as the top section of the PR description. Make the reviewer's job trivial.

**Critical rule: "A reviewer asked for it inline" is NOT sufficient provenance for a pipeline or db-schema change.** Inline review comments on an unrelated PR are feedback, not tickets. Pipeline and schema changes need their own ticket, their own rollout plan, and their own PR. See Step 4.

### Step 4 — Rollout plan for pipeline / db-schema / infra

If Step 2 flagged anything at `pipeline`, `db-schema`, or `infra`, the change is **not push-ready** until there's a written rollout plan that answers all of:

1. What commands run, in what order?
2. Against which environments (dev, UAT, prod)?
3. Who runs them? (Us, the client's ops person, the CI system?)
4. What's the rollback path if step N fails?
5. What does the "before" state of the system look like, and what does "after" look like?
6. What does live traffic see during the rollout window?

If any of these is unanswered, the change is not ready for a feature PR. Pull the change off the branch, open a separate ticket with the rollout plan, and ship the feature PR without it.

**Real example — Ordit PR 212, Apr 2026.** Eugene's inline comment asked to swap `prisma db push` → `prisma migrate deploy` and add a baseline migration. This is a `pipeline` + `db-schema` change. The correct response was:

> "Agreed this is a good direction. I'll keep it out of this PR and open a separate ticket with the rollout plan (run `prisma migrate resolve --applied 00000000000000_baseline` on UAT and prod, verify `_prisma_migrations` state, then merge the pipeline swap). That way the auth work here can ship on its own timeline."

Instead we shipped it in the feature PR. Eugene later reversed his position and called the changes "unplanned, unreviewed." The revert cost half a day and some trust.

### Step 5 — Em-dash and voice sweep

`git diff origin/<base>..HEAD | grep -n '—'` → must be empty. No em-dashes in any file we touch, including commit messages and PR descriptions. Hyphens with spaces, or restructure.

Same sweep for `X, not Y` rhetorical constructions in any README / PR-description prose we're writing.

### Step 6 — Final hostile-reviewer filter

Read the `git diff --stat` one more time, pretending to be the most aggressive reviewer on the team. Ask:

- Could anything in this diff be reasonably called "unplanned, unreviewed infrastructure change"?
- Could anything be called "scope creep" or "drive-by refactor"?
- Is there any file in the diff that a reviewer would open and say "why is this in this PR"?

If the answer to any is yes — even if the change is technically correct, even if a reviewer verbally asked for it — rework the branch.

### Step 7 — Reproduce the client's CI gauntlet locally

Read the client's CI config (`bitbucket-pipelines.yml`, `.github/workflows/`, `.gitlab-ci.yml`) and run the exact commands on the exact Node version locally before pushing. Do not assume passes. Capture exit codes.

**Ordit (`fireauditors1/be`) specifically** — reproduce their PR gauntlet:

```bash
cd ~/workspaces/ordit/be
git fetch origin <base-branch>
# Trap 1 — VPS has NODE_ENV=production by default. That silently skips
# devDeps (eslint, jest, nest CLI, prisma client generator). yarn install
# will say "Done" but the binaries will not exist.
export NODE_ENV=development
export NODE_OPTIONS="--max-old-space-size=4096"
yarn install --frozen-lockfile   # Trap 1 gate
npx prisma generate
yarn format                       # must leave `git status` clean
yarn lint                         # must be exit 0
yarn test                         # must be exit 0
yarn build                        # must be exit 0
node_modules/.bin/tsc --noEmit    # belt-and-braces type check (not in their CI)
git diff <base-branch>..HEAD | grep '—' && echo 'EM-DASH FOUND - fix before push'
git merge-tree <base-branch> HEAD | grep -E '^<<<<<<<|^=======' && echo 'MERGE CONFLICT - rebase before push'
```

All of those must be exit 0 / empty grep before the push. If any step fails, the push does not happen.

**Also read before push:** every open comment thread on the PR from every reviewer. Not just the latest. If a previous comment asked for something and it was done, verify it's still done. If a comment is ambiguous, classify it before pushing. Never push believing "Eugene said do X so I did X" without a direct-quote receipt pulled from the Bitbucket API (`GET /repositories/<ws>/<repo>/pullrequests/<id>/comments`).

### Step 8 — Only now: push

```
git push origin <branch>
```

Then:
- Paste the Step 3 provenance list into the PR description if it isn't already there.
- Watch PR activity every 2-4h while open: `curl -u code@ecodia.au:<API_KEY> "https://api.bitbucket.org/2.0/repositories/<ws>/<repo>/pullrequests/<id>/activity?pagelen=30"`. Surface any new reviewer comment immediately.

## Do

- Keep PRs narrow. One ticket, one PR, one concern.
- When a reviewer asks for something out of scope inline, **respond with "good call, separate PR"** and open a new ticket. Do NOT quietly expand the current PR.
- Document every non-obvious change at the top of the PR description with provenance.
- When a pipeline or schema change is needed, write the rollout plan before writing the code.
- Test pipeline and schema changes against a production-like clone *and* document the test. "Tested locally" is not enough.

## Do not

- Expand a feature PR to cover "related" pipeline or infra work, even if it's technically correct, even if a reviewer asked for it inline.
- Ship `bitbucket-pipelines.yml` changes in a feature PR.
- Ship schema migrations in a feature PR unless the feature IS the schema change.
- Assume that "reviewer asked for it inline" = "reviewer will defend it politically two days later."
- Push to a client remote without running Steps 1-6.
- Use `prisma db push` on any repo that has migration history. Use `prisma migrate deploy`. But if the existing repo uses `db push`, do not flip it in a feature PR — that's a separate rollout.

## Verification after each push

After `git push`, before moving on:

1. Run `git log origin/<branch> -1` to confirm the push landed.
2. Pull the PR activity from the Bitbucket / GitHub API and check for new reviewer comments every 2-4 hours while the PR is open. Surface anything non-trivial immediately.
3. Update the client's `.md` file in `~/ecodiaos/clients/<slug>.md` with a one-line note on what was pushed and the resulting reviewer response.
4. Update `status_board` with the new PR state.

## Origin

Apr 23 2026. Ordit PR 212 (`feat/cognito-be-integration`). Eugene's inline review comment on Apr 20 (id 785397745) explicitly requested three infra changes: add migrations support ("Which is a good idea"), swap `prisma db push` to `prisma migrate deploy` in `bitbucket-pipelines.yml`, and update the `README.md`. We shipped exactly what he asked, with a documented baseline migration (`04332ee`, tested against a UAT clone for P3005). Two days later (Apr 23, comment id 786876526) Eugene reversed his position and called the changes "unplanned, unreviewed infrastructure changes that were not part of this task." The reversal was dishonest about provenance but operationally correct — flipping a live-prod pipeline from `db push` to `migrate deploy` needs a coordinated `prisma migrate resolve --applied` on both databases before the pipeline change lands, which is staged rollout, not a feature PR. Revert (`24ab453`) landed Apr 23 ~14:34 AEST.

The lesson is not "Eugene is unreliable" (although he is, for this project). The lesson is: **pipeline and schema changes never belong in a feature PR, regardless of who asked for them inline.** The correct response to "also add a migration and swap the pipeline" on a feature PR is always "good call, separate PR."

Cross-reference: `~/ecodiaos/clients/ordit.md` for the fuller project context. `~/ecodiaos/patterns/authorised-branch-push-is-not-client-contact.md` for the separate rule about branch pushes not counting as client contact.
