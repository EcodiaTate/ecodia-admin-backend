# Ordit Factory dispatch preamble

This is the block I paste at the top of EVERY `start_cc_session` prompt targeting `ordit-backend`. It is non-negotiable context. The Factory session gets it before any task-specific instruction.

---

```
## You are working on Ordit backend (bitbucket.org/fireauditors1/be)

Before you touch any code, load these files in full and treat them as binding:
- clients/ordit/HOUSE_STYLE.md
- clients/ordit/REVIEWER_PROFILE.md
- clients/ordit/PR_BODY_TEMPLATE.md

The reviewer is Eugene Kerner. He is technically strong and scope-sensitive. Every change is read as a potential scope violation until proven otherwise. Read REVIEWER_PROFILE.md before writing a single line.

## Hard rules (violations abort the session)

### Scope discipline
You will produce a scope statement BEFORE writing code. Format:
"This task is: [X]. I will touch files in: [exact list]. I will not touch: migrations, bitbucket-pipelines.yml, prisma/schema.prisma management, CI config, Prisma generator config, adjacent modules not in the list, any other platform infrastructure."
The scope statement goes into the PR body Scope section verbatim and is CI-checkable against `git diff --name-only`.

### Blocker-stop rule
If you encounter a situation that requires touching anything outside the scope list - migrations, CI, pipelines, Prisma config, adjacent modules, tooling - STOP. Do not improvise. Do not "fix it while you're there." Do not add a migration folder because P3005 happens. Write up the blocker as a proposed separate PR, report, and wait. The single biggest source of Ordit rejections is improvising platform changes inside feature work.

### Splitting discipline
Never bundle a feature with platform work. If the task implies both, split:
1. Platform PR first, standalone, reviewed independently.
2. Feature PR second, smallest possible.
3. Cleanup PR trails, if needed.
Propose the split to the user BEFORE writing code. Do not write anything until the split is approved.

### Boring code wins
For Ordit specifically:
- Prefer explicit over clever.
- Prefer obviously-correct over efficiently-correct.
- Never refactor adjacent code "while you're there."
- Never rename variables that do not need renaming.
- Never add abstractions beyond what the ticket requires.
- Never remove pre-existing `console.log` that is not in the scope list.
Boring code gives no surface area for a reviewer looking for surface area.

### Existing pattern match
Match the codebase's existing patterns, even when they are not your preference. If the codebase uses `prisma db push`, you use `prisma db push`. If it uses 2-space indent, you use 2-space indent. When making a judgment call, cite the existing pattern: "Following the pattern in users.service.ts:447 where [X], this module [Y]." This makes objections harder - the reviewer would have to argue with existing code.

### Line-by-line reviewability
Every line you write must be something a human could review line-by-line without confusion. No dense one-liners. No "clever" code. No meta-programming shortcuts. The PR will be read line-by-line; write for that.

## Verification before committing

Run ALL of these before reporting complete:
1. `npx tsc --noEmit` - no new errors
2. `grep -rn "'COGNITO'" src/` - zero results (use AuthSource.COGNITO enum)
3. `grep -rn " as any" <files-you-changed>` - zero new casts
4. `grep -rn "console\.log" <files-you-changed>` - no NEW console.log
5. `git diff --name-only origin/uat...HEAD` matches the scope statement exactly
6. LF line endings everywhere (no CRLF drift)
7. The PR body draft follows PR_BODY_TEMPLATE.md with all required sections filled

If any check fails, fix before reporting.

## Output

When complete, report:
1. The exact file list changed (matches scope statement)
2. The PR body draft (ready to paste)
3. Any items where you stopped at the blocker-stop rule and need approval to continue
4. Any items where the reviewer may push back, flagged in PR body Anticipatory notes
```

---

## How I use this

1. When I call `start_cc_session({prompt, codebaseName: "ordit-backend"})`, I paste the block above FIRST, then the specific task.
2. Any deviation from the block inside the session is grounds for rejection at review time.
3. If a new rule gets surfaced by a future rejection, I add it to HOUSE_STYLE.md or REVIEWER_PROFILE.md and update this preamble to reference it if needed.

## Also load these patterns (grep before dispatch)

Before dispatching, grep `~/ecodiaos/patterns/` for:
- `client-code-scope-discipline.md`
- `client-push-pre-submission-pipeline.md`
- `authorised-branch-push-is-not-client-contact.md`
- `never-contact-eugene-directly.md`
- `verify-e2e-harness-loads-before-claiming-coverage.md`

These are binding. They inform what the session is allowed to claim and what it must flag.
