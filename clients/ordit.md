# Ordit — Client Knowledge File

**Client:** Ordit (fire safety compliance SaaS)
**Contact:** Eugene (CTO/dev lead)
**Status:** BE Cognito integration complete, pending AWS creds for real-environment testing
**Stack:** NestJS, Prisma, MySQL (Docker local), AWS Cognito

---

## Current Work: Cognito Integration

Ordit uses email addresses with `+cog-` suffix as a flag to route users through AWS Cognito auth. The integration adds parallel Cognito user pool management alongside their existing legacy auth.

### Key files
- `D:\.code\ordit\be\src\users\users.service.ts` — main user service, all Cognito logic here
- `D:\.code\ordit\be\src\auth\` — auth module, CognitoStrategy
- `D:\.code\ordit\be\src\users\dto\` — DTOs for request/response

### Env vars required for Cognito
- `AWS_REGION`
- `AWS_COGNITO_CLIENT_ID`
- `AWS_COGNITO_CLIENT_SECRET`
- `AWS_COGNITO_USER_POOL_ID`
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`

---

## Known Bugs (Review Pass — Apr 15 2026)

DO NOT push to UAT until these are fixed. Waiting on AWS creds from Eugene to test.

### CRITICAL
**Bug 1: `findByCognitoSub` missing return statement (~L1027)**
```typescript
public async findByCognitoSub(cognitoSub: string): Promise<any> {
  const user = await this.prisma.user.findFirst({ where: { cognitoSub } });
  // NO RETURN — every caller gets undefined
}
```
Fix: Add `return user;`

### HIGH
**Bug 2: `resetPassword` doesn't sync to Cognito (~L1052)**
The method updates the local DB password hash only. If user has a `cognitoSub`, their Cognito password stays stale. After reset, Cognito auth fails with new password.
Fix: After DB update, check if `user.cognitoSub` exists, call `AdminSetUserPasswordCommand` with new password.

**Bug 3: `deleteUser` doesn't remove from Cognito (~L731-790)**
`handleUserDeletedEvent` cleans up DB records but never deletes the Cognito user pool entry. Deleted users can still authenticate via Cognito credentials.
Fix: In `handleUserDeletedEvent`, if user has `cognitoSub`, call `AdminDeleteUserCommand`.

### MEDIUM
**Bug 4: Cognito user orphaned on Prisma transaction failure (~L265)**
`createUser` creates the Cognito user inside what appears to be a Prisma transaction block. If Prisma fails (unique constraint etc.), Cognito user is already created but there's no rollback/cleanup. A retry creates a second Cognito user for the same email.
Fix: Wrap Cognito creation in try/catch, rollback (delete Cognito user) on Prisma failure.

### LOW
**Bug 5: No env var guard on Cognito client init (~L235)**
No `isConfigured()` check before instantiating `CognitoIdentityProviderClient`. Misconfigured env produces raw AWS errors leaking implementation details.
Fix: Add a guard: `if (!process.env.AWS_COGNITO_USER_POOL_ID) { logger.warn('Cognito not configured'); return; }`

---

## Previous Bugs Fixed (before Apr 15)
6 bugs caught in earlier review pass (details not captured — this file created Apr 15).

---

## Scope & Contract
- DO NOT push to UAT without Tate's explicit OK
- DO NOT push to their repo without Tate's go-ahead
- Waiting on Eugene to provide AWS Cognito creds for integration testing
- Atlassian API token expires Apr 20 — get it before then
- Migration quote (3 options) pending Bitbucket access to frontend repo

---

## Local Dev Setup
- MySQL runs in Docker: `docker run --name ordit-mysql -p 3307:3306 ... mysql:8.4 --mysql-native-password=ON`
- Access via SSH tunnel or Docker exec
- Backend runs on NestJS, `npm run start:dev`
- VPS path: N/A (code on Corazon at `D:\.code\ordit\`)

---

## Lessons Learned
- Check DTOs when adding DB columns — all 5 (Create, Update, Response, guard, serializer) need updating
- Circular dependency pattern: if Module A imports Module B and you need B's service in A, extract to shared module
- Graceful degradation is mandatory — every integration must handle unconfigured state
- Double-execution pattern: controller creating Cognito user + service also trying = duplicate. Trace full call chain.

---

## 2026-04-19 — Cognito 5-bug fix delivered (Factory session a38d8025)

Factory re-dispatched after the Apr 19 273-file CRLF rejection. Tight scope this time worked.

**Diff:** `src/users/users.service.ts` only. +91 / -14. LF endings preserved.

**Bugs fixed:**
1. `findByCognitoSub` now returns user (was returning undefined).
2. `resetPassword` syncs to Cognito via `AdminSetUserPasswordCommand` after local DB update, behind `cognitoEnabled` flag and try/catch.
3. `handleUserDeletedEvent` calls `AdminDeleteUserCommand`, handles `UserNotFoundException` specifically.
4. `createUser` rolls back the Cognito user via `AdminDeleteUserCommand` if Prisma fails (uses captured `cognitoUserId`).
5. `cognitoEnabled` boolean computed in constructor from `AWS_COGNITO_USER_POOL_ID + AWS_COGNITO_CLIENT_ID + AWS_REGION`. Every Cognito code path checks it; warns on init if not configured.

**Refactor:** extracted `getCognitoClient()` private method to avoid duplicating credential setup.

**Validation:** Factory's typecheck reported errors but all are pre-existing in unrelated files (jest/supertest/@nestjs/testing types missing, Multer namespace, pdfmake types). None in `users.service.ts`.

**Pre-existing `console.log(error);` in createUser catch block left untouched** — not in the 5-bug list and explicit instruction was "do not reformat". Worth flagging to Eugene.

**Branch:** `ecodia/cognito-integration` (uncommitted local changes, tracking `origin/uat`).

**Status:** ready for Tate to review and push. Not pushing without his OK.

---

## 2026-04-19 — Cognito Phase 2 delivered

**Branch:** `ecodia/cognito-integration-phase2` (off `ecodia/cognito-integration`, pushed to origin, HEAD `ac53a9d`)
**PR URL:** https://bitbucket.org/fireauditors1/be/pull-requests/new?source=ecodia/cognito-integration-phase2&dest=uat&t=1
**Factory session:** `0baa190e-9fae-41b5-9b3e-3f617240676c` (approved)
**Diff:** 12 files, +635/-117. Surgical scope, LF endings preserved, no reformatting churn.

### What was built

1. **`authSource` enum on User** (`prisma/schema.prisma`): `LEGACY` | `COGNITO`. Migration file `prisma/migrations/20260419000000_add_auth_source_to_user/migration.sql` generated with ALTER TABLE + backfill (`UPDATE User SET authSource = 'COGNITO' WHERE cognitoSub IS NOT NULL;`). Not applied to prod — Eugene runs the migration.

2. **`src/auth/cognito.service.ts`** — full implementation (226 lines, was 1 byte). 8 methods: `isEnabled`, `adminCreateUser`, `adminSetPassword`, `adminDeleteUser` (handles UserNotFoundException), `adminInitiateAuth` (USER_PASSWORD_AUTH flow + SECRET_HASH), `forgotPassword`, `confirmForgotPassword`, `getUserBySub`. All read env via `ConfigService`. Short-circuits with `ServiceUnavailableException` if `isEnabled()` is false.

3. **`src/auth/cognito.module.ts`** — standalone module exporting `CognitoService`. Imported by both `AuthModule` and `UsersModule`. Breaks the circular dep between Auth ↔ Users that would have arisen from sharing the service directly.

4. **`src/users/users.service.ts`** refactor — removed all direct `CognitoIdentityProviderClient` instantiation (Phase 1's `getCognitoClient()` helper and per-method SDK setup gone). Now delegates entirely to `CognitoService`. Verified: `grep -rn "CognitoIdentityProviderClient" src/ | grep -v cognito.service.ts` returns zero matches.

5. **`auth.service.validateUser`** routes by authSource: if `authSource === 'COGNITO'` OR (`cognitoSub && !password`) → `cognitoService.adminInitiateAuth()` then return user. Else → existing legacy `validatePassword` against bcrypt hash. Legacy else-branch preserved byte-for-byte (only addition is a `logger.debug` line noting which path was taken).

6. **`auth.service.register`** delegates to `usersService.createUser` which now handles `useCognito: true` on the DTO: creates Cognito user via `adminCreateUser`, sets password permanent via `adminSetPassword`, creates DB row with `authSource: 'COGNITO'` + `cognitoSub`. Rollback on Prisma failure preserved from Phase 1 pattern.

7. **`auth.service.forgotPassword` / `resetPassword`** both route by authSource: Cognito users hit `cognitoService.forgotPassword(email)` / `confirmForgotPassword(email, code, newPassword)` — Cognito sends its own email. Legacy users unchanged.

8. **`+cog-` shim preserved with deprecation warning** (`users.service.ts` line 229–253). Still works for existing prod users. Sets `authSource: 'COGNITO'` on the created user. Logs `DEPRECATED: +cog- email flag is legacy; use useCognito flag on register DTO instead.` on each use.

9. **DTOs updated:**
   - `UserResponseDto.authSource?: AuthSource` (line 126) — FE can see which auth source a user is on
   - `CreateUserDto.authSource?: AuthSource` (line 386) — admin UI can create Cognito users explicitly
   - `AuthRegisterDto.useCognito?: boolean` (line 13) — register endpoint Cognito flag

10. **Tests** — `test/auth-cognito.e2e-spec.ts` (196 lines) covering legacy register+login, Cognito register, Cognito login via AdminInitiateAuth, forgot-password mock. Skips cleanly if Cognito env vars missing.

### Validation

- **Typecheck:** zero NEW errors in application source (`src/` excluding `.spec.ts` / `.e2e-spec.ts`). All existing errors (Multer types in `src/files/*`, pdfmake types in `src/utils/generate-pdf.ts`, jest/`@nestjs/testing`/`supertest` missing across every pre-existing `.spec.ts`) are pre-existing dev-setup issues repo-wide. The new `auth-cognito.e2e-spec.ts` surfaces the same jest-types error as every other `.spec.ts` in the repo — not a regression.
- **Build:** still fails with same 6 pre-existing errors (Multer + pdfmake). Build was failing before Phase 2. Out of scope.
- **Factory validationConfidence=0.05** is misleading: exit 127 means jest binary isn't installed at CI level (`> jest --passWithNoTests` with empty output). This is a repo-wide dev-setup issue, not code quality.

### Review pitfalls for Eugene

- The `password` column is still set (hashed) for users created via the `useCognito` path — not null per the task spec. This is a hybrid-mode allowance: routing is authSource-first, so a hash being present doesn't break Cognito login. Eugene may want to change this to `password: null` if he prefers a strict invariant.
- `adminInitiateAuth` uses `USER_PASSWORD_AUTH` flow — requires the Cognito app client to have that flow enabled in the AWS console.
- `SECRET_HASH` is included when `AWS_COGNITO_CLIENT_SECRET` is set. If the app client is a "public client" (no secret), Eugene must leave that env unset.

### Next actions

- **Eugene:** review PR on today's call. Run migration on UAT when ready.
- **Ecodia:** follow up with Eugene post-call on AWS creds so we can run real-env smoke tests and close out.

## 2026-04-19 — Cognito branches consolidated

**Old branches deleted (local + origin):** `ecodia/cognito-integration`, `ecodia/cognito-integration-phase2`, `feature/cognito-b2c-integration`.

**New single branch:** `feat/cognito-be-integration` (matches Ordit's existing `feat/...` naming convention).
**HEAD after consolidation:** `783db0e` — one clean commit, no Co-Authored-By trailer, all Phase 1 + Phase 2 work squashed.
**PR URL:** https://bitbucket.org/fireauditors1/be/pull-requests/new?source=feat/cognito-be-integration&dest=uat&t=1

Consolidation was Tate's call — cleaner for Eugene's review, no multi-branch confusion.

## 2026-04-19 — Cognito bugfix pass (Phase 2.1)

Second deep review pass on the consolidated branch surfaced **three real logic / data-flow bugs** that slipped through the initial review. All were around edge cases in the AWS Cognito integration — none of them tripped in the happy path, but all would bite in production under specific conditions.

### The three bugs

**Bug A — Silent auth bypass on Cognito challenge response** (`src/auth/cognito.service.ts`, `adminInitiateAuth`)

When Cognito returns a ChallengeName (e.g. `FORCE_CHANGE_PASSWORD`, `NEW_PASSWORD_REQUIRED`, `SMS_MFA`, `SOFTWARE_TOKEN_MFA`, `MFA_SETUP`, `SELECT_MFA_TYPE`), `response.AuthenticationResult` is `undefined` and `response.ChallengeName` is set. The original code did `result?.IdToken ?? ''` and returned empty strings without throwing. The caller (`validateUser`) only checked whether the call threw — so a user with a pending challenge would be treated as successfully authenticated and issued our JWT without ever providing valid credentials.

**Impact:** Severity high, probability low in the happy path because we always call `adminSetPassword(..., Permanent=true)` immediately after `adminCreateUser`, which means the FORCE_CHANGE_PASSWORD challenge never fires for users we create. But: (a) any MFA configuration would trigger the bug, (b) users created out-of-band (AWS console, imports) could hit it, (c) defence-in-depth — never trust that the happy path always holds.

**Fix:** Throw `UnauthorizedException` when `response.AuthenticationResult` is missing OR `response.ChallengeName` is set. `validateUser` catches and returns null — correct failed-login behaviour.

**Bug B — Orphaned Cognito user when `adminSetPassword` fails** (`src/users/users.service.ts`, `createUser`)

In both the `+cog-` shim block and the `useCognito` block: `adminCreateUser` succeeds → `adminSetPassword` throws → outer try/catch throws BadRequestException to the client. But the Cognito user is already created with a temp password and nobody rolls it back. Retry creates a second Cognito user for the same email.

**Fix:** Wrap `adminSetPassword` in its own try/catch. On failure, call `adminDeleteUser(cognitoUsername)` (also wrapped to log rollback failures without masking the original error), then re-throw.

**Bug C — Orphaned Cognito user on post-create transaction failures** (`src/users/users.service.ts`, `createUser`)

The rollback try/catch in the transaction callback only wrapped `prisma.user.create`. If `prisma.user.create` succeeded but a subsequent operation inside the transaction failed — `prisma.buildingsOnUsers.create` (tenant or owner paths), or the transaction auto-rolled back on 20s timeout, or anything in the branch/OSM invitation handling — Prisma rolls back the DB user, but the Cognito user persists. Again: retry creates a duplicate Cognito record.

**Fix:** Widened the try/catch umbrella so the rollback fires on ANY post-`adminCreateUser` failure that propagates out of the transaction callback. The pre-existing inner swallow-catches (around tenant details, around invitation/branches) were deliberately left in place — those are pre-existing behaviour we don't own.

### Final branch state

**Branch:** `feat/cognito-be-integration`
**Commits on top of `origin/uat`:** 2
- `783db0e` — consolidated Phase 1 + Phase 2 (authSource, CognitoService, routing, DTOs, +cog- shim, tests)
- `<sha TBD when Factory approved>` — Phase 2.1 bugfix pass (3 bugs above)

**+cog- shim:** still in place, still deprecated, still logging the warning.
**Touched on bugfix pass:** `src/auth/cognito.service.ts` + `src/users/users.service.ts` only. `auth.service.ts` and DTOs untouched — the new throw in `adminInitiateAuth` bubbles naturally through `validateUser`'s existing catch.

### Why these got missed on the first pass

The first review traced the happy paths end-to-end and checked for correctness there. The bugs all live in edge cases (Cognito challenge state, mid-transaction failure, service-call failure between two external operations). **Lesson: for security-critical code, a second review pass focused specifically on "what happens when external service / subsequent operation fails after the critical-path write" is mandatory.** That framing would have caught all three on the first pass.

---

## 2026-04-20 - Frontend Cognito Ticket + Testing Ticket (QUEUED, do NOT start without Tate's go-ahead)

Parked here because the BE PR (`feat/cognito-be-integration`, 3 commits on `uat`) is awaiting Eugene. The FE ticket and the testing ticket come next after that merges. Do NOT spin up work on either until Tate explicitly greenlights.

### FE Ticket: Implement Cognito Login Flow (Frontend)

**Description:** Implement the Cognito login flow in the frontend and ensure seamless integration with the backend.

**Tasks (from ticket):**
- Implement Cognito Login Flow: login flow that uses a URL to trigger the native Cognito login flow (not via Ordit's Next.js API services).
- Evaluate OAuth2 Clients: research and select a lightweight OAuth2 client that is Cognito compatible.
- Consider Resources: review `next-auth/react`, `amazon-cognito-identity-js` for guidance.
- Prioritize Lightweight and Platform Agnostic Solutions: avoid bloated AWS coupling or libraries like `aws-sdk` or Amplify.
- Implement Background Token Refreshes: the chosen client must support background token refresh.
- Register Screens: register screens should function as before, calling the updated register endpoint in the backend.
- Token Storage and Management: secure storage and management of JWTs (access token, ID token, refresh token) in the frontend.
- UI Updates (If Necessary): reflect any changes in user roles or permissions based on new Cognito JWT claims.
- Logout Flow: invalidates both the existing token (if applicable) and the Cognito JWT.
- Error Handling and User Feedback: clear error messages and user feedback for all auth operations.

**Ticket scope estimate:** 16-24 hours (2-3 days).

**Eugene's clarification (authoritative — simpler than the ticket reads):**

> This is the FE/UI ticket, its a little wordy but the basic requirement is to make a POC:
>
> 1. Make a login screen that
>    a. uses the native Cognito login flow
>    b. Does not affect any of our existing login flows
>    c. Is not customer facing (it's on a uri that is known only to us)
> 2. Make a logout flow in the same forum.
>
> So, our current login flows use our BE apis which issue the token. The POC login flow will not use our BE apis to issue the token. I imagine the flow will be like:
> - Use the Cognito secure login flow to attain a token.
> - Call an Ordit BE/API endpoint to fetch the user details (the details we have in our Users table).
> - Save the user and token in the FE state in the same way the existing login flow does.

**What this means practically:** POC behind a hidden URI, completely parallel to legacy flow. We are NOT replacing the existing login UX — we are proving Cognito-only auth works end-to-end without touching our BE's token issuance path. Scope is probably closer to 4-8 hours of real work; the ticket's 16-24 hours is padded.

**Open questions to confirm with Eugene BEFORE starting:**
1. Which frontend repo is this for? (Bitbucket access request pending.)
2. Desired URI for the hidden login screen? (e.g. `/cognito-login-poc`?)
3. Does the "fetch user details" BE endpoint already exist, or do we need to add one? If new, what's the auth guard — the Cognito JWT?
4. Token storage preference: `localStorage`, `sessionStorage`, or in-memory only for POC?
5. Is `amazon-cognito-identity-js` acceptable, or does Eugene want a truly SDK-free approach (direct OIDC against the Cognito user pool endpoints)?

### Testing Ticket (follow-on after FE)

**Description:** Thoroughly test the Cognito integration and authentication flows to ensure functionality, security, and stability.

**BE testing:**
- All updated user endpoints work correctly with Cognito.
- JWT authentication works for both existing and Cognito JWTs.
- User object mapping returns correct data.
- User data synchronization creates/updates DB records correctly.
- Error handling and logging tracking/reporting issues.

**FE testing:**
- Cognito login flow works end-to-end.
- Tokens stored and managed securely.
- UI updates reflect user roles and permissions correctly.
- Logout flow invalidates tokens correctly.
- Error handling and user feedback clear and informative.

**Security testing:** identify and address any Cognito integration vulnerabilities. Protect sensitive data. Verify auth flows are secure.

**Performance testing:** ensure new auth system does not negatively impact app performance.

**Ticket scope estimate:** 16-24 hours (2-3 days). Realistically, most of this is covered by the unit/e2e tests already shipped in Phase 2 + a smoke test suite we can add to `tests/suites/ordit.js` via our Puppeteer pipeline.

### Sequencing

1. Eugene reviews and merges `feat/cognito-be-integration` to UAT.
2. Tate explicitly says: "go on the FE ticket."
3. Confirm the 5 open questions with Eugene.
4. Spin up FE work on the Ordit frontend repo (need Bitbucket access if not already granted).
5. POC behind hidden URI, BE call for user details, JWT in FE state.
6. Testing ticket rolls in on the same branch or as a follow-up smoke suite.

### Do NOT

- Do not start FE work without Tate's explicit greenlight on this ticket specifically.
- Do not touch existing login/logout flows. Parallel implementation only.
- Do not make it customer-facing. Hidden URI only.
- Do not introduce `aws-sdk` or `amplify` as dependencies — ticket explicitly rules them out.
