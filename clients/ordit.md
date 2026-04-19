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
