# Ordit PR body template

Every Ordit PR body uses this structure. No sections are optional. Fill every one or delete it. Do not reorder - Eugene reads top-down and the first two sections must defuse scope and approach before he sees the diff.

---

```markdown
## Why
[One sentence. The business trigger. No changelog prose. No "this PR does..."]

## Scope
This PR touches:
- [path/to/file1.ts] - [one-line what changed]
- [path/to/file2.ts] - [one-line what changed]
...

## Out of scope (important)
This PR intentionally does NOT:
- [Thing considered and chosen against, with one-line reason]
- [Adjacent improvement visible during the work, deferred]
- [Any platform / migration / CI / tooling work that would be a separate deliverable]

If any of the above become necessary for this feature to work, that is a separate PR, not a drive-by change here.

## Approach
[The decision made. The alternative rejected, and one sentence on why. Cite existing code patterns being followed with file:line where relevant: "Following the pattern in users.service.ts:447, ..."]

## Anticipatory notes
[Pre-emptive answers to likely reviewer concerns. Call out anything in the diff that LOOKS scope-creep-y and explain why it is not. Call out anything that relied on an earlier in-thread comment from the reviewer, with a quote or link.]

## Testing
- [Specific command run, e.g. `yarn test src/users/users.service.spec.ts` - green]
- [Specific flow tested manually, e.g. "Registered + logged in a Cognito user against LocalStack - green"]
- [Edge cases exercised]
- [What was NOT tested, explicitly: "e2e suite not run because test:e2e is broken at config level - noted in clients/ordit.md"]

## Review focus
[The two or three places you are least sure about. Point the reviewer at them directly instead of hoping they find them.]
```

---

## Examples of anticipatory-framing lines that work

- "This PR intentionally does not migrate away from `prisma db push`. The feature works on the existing db-push-managed schema. A platform PR to introduce `migrate deploy` tooling will be opened for independent review."
- "The `auth-register.dto.ts` is a 3-line empty extension deliberately - there is no delta from `CreateUserDto` and the empty class preserves the route-level type identity without adding synthetic fields."
- "I considered extracting the Cognito init into a factory provider, but the existing pattern in `src/users/users.service.ts` uses direct client construction and this PR matches that to stay within scope."

## Examples of anticipatory-framing lines that will NOT work

- "This PR is fully production ready." (Word `production-ready` triggers a scope-look. Do not use it.)
- "Just a quick fix." (Nothing is "just" anything on this reviewer's PRs.)
- "Cleaned up some adjacent code." (Never do this. Delete the change.)
- "I took the liberty of also [X]." (No liberties.)

## When in doubt

If a section feels like it is reaching, delete it. Shorter PR bodies are fine. The required sections are `Why`, `Scope`, `Out of scope`, `Approach`, `Testing`, `Review focus`. `Anticipatory notes` is optional but usually worth it.
