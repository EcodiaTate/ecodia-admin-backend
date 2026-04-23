triggers: client-code, factory-client-dispatch, scope-creep, prisma, migration, pipeline, bitbucket-pipelines, pr-review, eugene, ordit, production-ready, fix-everything

# Client code scope discipline — never expand scope even when Tate says "production ready"

## The rule

When working on a client codebase, the ticket/PR scope is a **hard boundary**. Infrastructure changes (migrations, pipeline switches, deploy strategy, CI changes, framework version bumps) are ALWAYS separate deliverables with their own rollout plan, even if they seem like obvious improvements.

"Fix everything around what we've done" or "make it fully production ready" from Tate means **finish the scoped work to production quality**. It does NOT mean "add new scope you think should exist."

## Do

- Keep PR diffs to what the original ticket asked for, plus the bug fixes / polish for that exact scope.
- If you spot a legitimate infra improvement (migrations, better pipeline, better deploy strategy), **log it as a separate ticket idea in status_board or ordit.md / {client}.md**. Do not introduce it in the current PR.
- When unsure whether a change is in scope, err on the side of leaving it out and flagging it in the PR description as a suggestion.
- Line-by-line human review of every diff before it lands on a client branch. Every single line.
- Match the client's existing patterns. If they use `prisma db push`, you use `prisma db push`. If they use `console.log`, you don't introduce a logging library. Consistency > your preference.
- When Tate says "production ready", ask yourself: "production ready WITHIN the scope that was agreed?" and stop there.

## Do Not

- Do NOT switch `prisma db push` to `prisma migrate deploy` as a side-effect of a feature PR. That's a live-DB deploy strategy change requiring planned multi-step rollout against prod and UAT databases BEFORE the pipeline change ships.
- Do NOT add CI changes, pipeline changes, or deploy changes to a feature branch.
- Do NOT add migrations when the codebase doesn't use migrations.
- Do NOT "clean up" the codebase while doing a feature. Style, structure, and pattern changes go in their own PR.
- Do NOT introduce a "best practice" the client's codebase hasn't adopted. They know their constraints; you don't.
- Do NOT interpret a Tate directive to "fix everything" as license to redefine scope. Clarify scope with Tate if ambiguous.

## Protocol before dispatching any client-codebase Factory session

1. **Read the ticket/scope line by line.** What does it ACTUALLY ask for? Write the deliverable in one sentence.
2. **Grep ~/ecodiaos/patterns/ for matching triggers** (client name, tech being touched).
3. **Read ~/ecodiaos/clients/{slug}.md** in full.
4. **Check the client codebase for existing patterns** (`grep -r "prisma db push" .`, `cat bitbucket-pipelines.yml`, etc.). Match what's there.
5. **Scope the Factory prompt tightly.** Explicit acceptance criteria, explicit files touched, explicit "DO NOT touch" list. Include: "Do not modify bitbucket-pipelines.yml. Do not add migrations. Do not change deploy strategy."
6. **Human review line-by-line before push.** No exceptions.
7. **If ANY infra-adjacent file is touched in the diff**, stop and ask Tate whether that's in scope.

## Verification

Before approving any client Factory session for push:
- `git diff origin/{base}..HEAD --stat` - look for surprise files (pipelines, migrations, CI, Dockerfile, package manager config)
- Any of these in the diff without explicit ticket authorisation → REJECT and re-dispatch with tighter scope.

## Origin

2026-04-23: Ordit PR 212 second review. Eugene reviewed and requested changes with direct language: "The AI agent has introduced unplanned, unreviewed infrastructure changes that were not part of this task. Please do not use an AI agent to submit code you have not reviewed line by line."

Context: after Tate's "fully production ready, fix everything around what we've done" directive on Apr 21, the Factory/audit pass introduced a Prisma baseline migration + a bitbucket-pipelines.yml switch from `prisma db push` to `prisma migrate deploy`. Neither was in the Cognito feature scope. Eugene - correctly - rejected them as a live-DB deploy strategy change that needs planned multi-step rollout, not a PR drop-in.

Revert 24ab453 pushed 14 min after Eugene's review, dropping the migrations folder and restoring `prisma db push --accept-data-loss`. Branch back to Cognito feature work only. Awaiting Eugene re-review.

The relationship cost of this incident is real. Eugene's language went from technical nits to directly questioning whether AI-agent output should be trusted in the repo. That's a trust deposit withdrawn.

Never again.
