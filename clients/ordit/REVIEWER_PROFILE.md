# Ordit reviewer profile - Eugene Kerner

This is internal. It informs how we write code and PR descriptions for Ordit. It is never shared, quoted, or referenced in any outbound communication. Eugene is a colleague and a good reviewer; this profile exists because understanding him means shipping less friction.

## Who he is

Eugene Kerner, CTO/dev lead at Spatial & Compliance Pty Ltd (Fire Auditors / Ordit). Technically strong. Opinionated on style. Owns the codebase. Has been burned before by AI-generated code that "got too clever" or expanded scope uninvited.

## What he rejects on

Ranked by frequency in the PR 212 review history:

1. **Scope creep, especially infrastructure changes in feature PRs.** Migrations, CI config, Prisma tooling, pipeline scripts. His most severe rejections are scope-based. He has said: "The AI agent has introduced unplanned, unreviewed infrastructure changes that were not part of this task."
2. **String literals where enums exist.** `'COGNITO'` vs `AuthSource.COGNITO`. He has flagged this at 5 sites in a single review.
3. **`as any` and similar casts.** He reads them as "your typings aren't set up properly."
4. **Client-supplied switches that should be server-decided.** A `useCognito` boolean on a DTO is a bug in his worldview. The server, not the client, decides auth source.
5. **Dead code from incomplete refactors.** Fallback branches that never fire after a backfill. Flags that are always true. He treats these as noise.
6. **Test drift.** Tests that pass despite testing the wrong thing. A test that sends a DTO field that no longer exists and still goes green is a trust hit.

## What neutralizes him

1. **Tight scope, explicitly stated.** "This PR touches X files. It does not touch migrations, CI, or pipeline." Anticipatory framing at the top of the PR body disarms the scope objection before he reads a line of code.
2. **Matching his existing patterns.** If the codebase uses `prisma db push`, use `prisma db push`. If it uses Mocha style for tests, use Mocha style. Citing his existing file-and-line as the convention being followed makes objections harder - he would have to argue with his own code.
3. **Flagging trade-offs he would have made the same way.** "I considered X but chose Y because [Z]." He respects the reasoning being shown, not the conclusion being hidden.
4. **Showing the test ran.** "Ran `yarn test src/users/users.service.spec.ts` - green. Ran the Cognito register+login flow against LocalStack - green." Not "tests pass."
5. **Owning the failure.** When he is right (and he usually is on mechanics), acknowledge directly. No "we thought...". Just "you're right, fixed in 24ab453."

## What triggers a bigger reaction than the fault

- **Surprise infrastructure.** A quiet migration folder appearing in a feature PR. A pipeline swap that "wasn't part of the task." These trigger RFC-worthy objections even when the code inside the migration is fine.
- **Claims of thoroughness that turn out to be hollow.** "Fully production ready" is a red flag to him if the PR contains anything out-of-scope. The word "production-ready" should not appear in PR bodies unless the PR is specifically a production-readiness deliverable.
- **Un-audited AI output.** He has asked in writing: "Please do not use an AI agent to submit code you have not reviewed line by line." Every Ordit PR we ship must be line-by-line reviewable and owner-vetted. Tate signs off on the push; the push is our assertion that the code has been read.

## What he does not care about

- Pure style nits inside code he respects. He will flag them but will not reject over them.
- Long PR descriptions, if they are honest and structured.
- Acknowledging "we should do X later" in the PR body, as long as X is not silently in the diff.

## His review patterns

- **Silent for 24-48h then a long review.** He batches. Do not nudge inside 48h.
- **Inline comments with a terse verdict at the end.** "This PR cannot be merged." / "Awesome." Read the verdict first, then read the inline comments as a justification for it.
- **He can reverse his stated position between comments.** PR 212 example: he asked for the `db push` -> `migrate deploy` swap in an inline comment on Apr 20, then rejected the implementation of that swap as "unplanned infrastructure" on Apr 23. Lesson: treat every "would be a good idea" comment as conversational, not directive. Do not ship an infrastructure change on the strength of a one-line suggestion. Build the platform PR separately and let him review it on its own terms.

## How this applies to every Ordit dispatch

Every Factory session prompt for `ordit-backend` must include the Ordit dispatch preamble (see `DISPATCH_PREAMBLE.md`), which includes:
1. The scope statement he will read at the top of the PR body.
2. The explicit out-of-scope list.
3. Instruction to stop if the work would require touching anything outside scope.
4. Instruction to match existing patterns, not improve them.

## Origin

Built from PR 212 review history (Apr 19 - Apr 23, 2026): comments 785397745, 785402218, 785403485, 785403768, 785398791, 785405834, 785392047, 786876526. Refined as further reviews surface new patterns. Every future rejection that introduces a new reaction-mode or neutraliser appends here.
