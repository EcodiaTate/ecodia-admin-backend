---
triggers: edge-function, supabase, default-param, missing-param, write-endpoint, mutation, idempotency, deno-serve
---

# Edge Function defaults must be safe - never write on a missing param

## The rule

If an Edge Function branches on a query param or request body field to decide whether to READ or WRITE, the default (when the param is absent or malformed) MUST be the READ path. A missing param is not permission to mutate.

```typescript
// WRONG - missing ?direction= defaults to write
const direction = url.searchParams.get('direction') ?? 'to-excel'

// RIGHT - missing ?direction= defaults to read
const direction = url.searchParams.get('direction') ?? 'from-excel'
```

## Why this matters

Edge Functions are invoked from many places: pg_cron jobs, client code, manual `curl` probes, webhooks, misconfigured CI pipelines, old bookmarks, retries from queue workers. Any of these can fail to include a param. When the absent-param default is the write path, that failure becomes a data-integrity event.

Real example (Co-Exist, 2026-04-20): `excel-sync` Edge Function defaulted to `direction=to-excel`. A probe curl without `?direction=...` pushed 67+ rows to the Master Impact Data Sheet, polluting it with duplicate data that had to be manually reconciled. Cost: an hour of cleanup and a trust hit with the client's board. Fix: default flipped to `from-excel`, making bare invocations safe reads.

## Protocol - applies to every Edge Function that has a direction/mode/action switch

1. **Identify the decision point.** Grep for `searchParams.get` and `req.json()` field lookups near the top of the handler.
2. **List the possible values.** Each one should be classified: read-only, read-write, write-only, destructive.
3. **Choose the default as the safest read-only value.** If no read-only value exists, the default should throw a 400 Bad Request, NOT silently pick a write mode.
4. **Assert in code** when the param is business-critical:
   ```typescript
   const direction = url.searchParams.get('direction')
   if (!direction) {
     return new Response(JSON.stringify({ error: 'direction required' }), { status: 400 })
   }
   ```
5. **Document the default in a top-of-file comment.** Future maintainers need to know why.
6. **If the function is called from pg_cron, the cron command must pass the param explicitly.** Never rely on the default from a scheduled job.

## Do

- Default to read-only branches for any switch that has one
- Return 400 when the safe default is ambiguous
- Log the direction/mode at the start of every invocation so the failure shows up in Edge Function logs
- Test bare invocation (`curl <function-url>` with no params) in every E2E suite

## Do NOT

- Default to write/mutate/push/sync on absent params
- Assume pg_cron will always include the param (it won't, the day someone edits the cron command)
- Silently fall back to a destructive default because "callers should know better"

## Applies to

- All Supabase Edge Functions across EcodiaOS-owned and client projects
- Any API handler with a mode/direction/action query param or body field
- Especially: sync functions, import/export, data migrations, webhooks that can toggle between probe and apply modes

## Origin

2026-04-20/21, Co-Exist `excel-sync` pollution incident. The function had `direction ?? 'to-excel'` as the default. A direction-less probe written for diagnostic purposes pushed 67 rows to the live sheet. Deploy commit `e7114f2` flipped the default to `from-excel` and added the migration gate + dedup safety net. The tight coupling between "write default + callers can forget params" is the actual root cause; a missing-param check would have caught it earlier.
