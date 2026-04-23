# Ordit backend - house style

This file is loaded verbatim into every Factory session that touches `ordit-backend`. Every rule is enforceable and grep-able. When a new rejection surfaces a new rule, add it here.

## Enums, types, casts

- **Use generated Prisma enums in every comparison, never string literals.** `user.authSource === AuthSource.COGNITO`. Never `=== 'COGNITO'`. Applies to all Prisma-generated enums, not just AuthSource.
- **No `as any` casts anywhere in production code.** If types are wrong, fix the types. The single exception is pre-existing legacy code you did not touch - do not fix or remove, but do not introduce new casts.
- **No `as unknown as X` double casts.** Same rule.
- **`Promise<any>` is a type-declaration gap.** If you are writing a new function or touching an existing one, type the return. `Promise<User | null>` not `Promise<any>`.

## DTOs

- **Creation switches belong in env, not on the DTO.** A client request must never be able to pick its own auth source, tenant, mode, or creation path. The server decides based on env config. The `User.authSource` field on the persisted entity records the OUTCOME of that decision.
- **DTO scan-all rule.** When you remove a problematic field from ONE DTO, grep every DTO in the module for the same field before declaring the fix complete. The original bug is rarely in only one place. (Origin: PR 212 first pass removed `authSource` from AuthRegisterDto but missed the mirror leak on CreateUserDto.)
- **Adding a DB column means updating five things.** CreateDTO, UpdateDTO, ResponseDTO, any guards/middleware that read the field, any serializer. Miss one and it is a shipped bug.
- **Empty extension DTOs are fine.** `export class AuthRegisterDto extends CreateUserDto {}` is the correct shape when there is no delta. Do not add synthetic fields to "document" the inheritance.

## Tests

- **Do not send dead fields in test request bodies.** `ValidationPipe({ whitelist: true })` silently strips non-whitelisted fields. A test that passes despite sending `useCognito: true` on a DTO that no longer has that field is a read-risk for the reviewer - they see a rejected pattern surviving in tests. Remove dead fields.
- **e2e tests require LocalStack Cognito.** `test:e2e` is currently broken at config level (see `clients/ordit.md` Apr 23 E2E suite finding). Do not claim "e2e validated" unless you have run the suite and it went green locally. A suite that fails to load is not coverage.

## Prisma and migrations

- **This codebase uses `prisma db push --accept-data-loss`, not `prisma migrate deploy`.** That is the platform's current posture. Do not swap it inside a feature PR. A migration-tooling change is a separate platform PR with its own rollout plan, reviewed independently.
- **Do not add a `prisma/migrations/` folder inside a feature PR.** Even if the reviewer has previously said migrations are "a good idea." If migrations are the right call, they are a standalone PR that lands before the feature PR.
- **Prefer `prisma migrate deploy` over `db push` in environments with history.** But only when that is the task. Not as a drive-by fix.

## Circular dependencies and modules

- **If Module A imports Module B and you need B's service in A, extract the shared service into its own module.** Do not fix the import graph with `forwardRef` unless the shared-module extraction is genuinely worse. (Origin: CognitoModule extracted to break Auth <-> Users cycle.)
- **Unused imports are a code smell.** If you imported something and did not use it, you misunderstood the design. Remove them before committing.

## Integrations

- **Every external integration must handle unconfigured state gracefully.** Check `isConfigured()` before calling. Log a warning on module init if config is missing. Never crash on startup because AWS keys are absent.
- **Double-execution check on every integration path.** If a controller calls a service that also calls the external API, you will get duplicate operations. Trace the full call chain end to end.
- **Sync on every credential-mutation path.** If a user can change their password through legacy and Cognito paths, both paths must sync. Missing one is a shipped bug.
- **Rollback on failure.** If you create a Cognito user and the DB insert fails, delete the Cognito user. Capture the ID before the DB call so you have it for rollback.

## Style

- **No em-dashes.** Hyphens with spaces (` - `), commas, or restructure.
- **LF line endings.** Not CRLF. A 273-file CRLF diff already caused one rejection.
- **No reformatting churn.** If the file has tabs, use tabs. If it has 2-space indent, use 2-space indent. Match the existing style exactly.
- **No renaming variables that did not need renaming.** No refactoring adjacent code "while you're there." No new abstractions beyond what the ticket requires.
- **No `console.log` left behind.** If it was already there in the surrounding code, leave it. Do not add new ones.

## The boring-code rule

For Ordit specifically, over-index on boring solutions:
- Prefer explicit over clever.
- Prefer obviously-correct to efficiently-correct.
- Never refactor adjacent code.
- Never rename variables that do not need renaming.
- Never add abstractions beyond what the ticket requires.

Boring code gives nothing to object to. Not about quality. About surface area for a reviewer looking for surface area.

## Verification before commit

Run all of these before pushing. If any fails, fix before committing.

1. `npx tsc --noEmit` - no new errors introduced
2. `grep -rn "'COGNITO'" src/` - zero results
3. `grep -rn " as any" src/ | grep -v "^src/.*legacy/" | grep -v "// pre-existing"` - zero results in changed files
4. `grep -rn "console\.log" src/` - no NEW console.log in changed files
5. `git diff --name-only origin/uat...HEAD` should match the scope statement in the PR body. If it does not match, either the scope is wrong or the code is wrong - reconcile before pushing.
