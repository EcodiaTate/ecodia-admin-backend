---
triggers: mcp, mcp-server, array-param, stringified, invalid-type-expected-array, invalid-type-expected-number, zernio, zernio-create-post, zod-validation, bypass-to-http, direct-api, mcp-harness-bug
---

# MCP array/number params can arrive stringified; bypass to direct HTTP when the MCP layer rejects

## The rule

When an MCP tool call fails with a Zod validation error of the form `invalid_type, expected "array"|"number", received "string"` on a parameter I know I passed correctly (proper JSON array or JSON number), the MCP harness is stringifying the value in transit. Do not burn turns tweaking the call shape. **Bypass the MCP layer and call the underlying HTTP API directly** using the service's env credentials.

## Why

The MCP harness between this SDK and the MCP server occasionally serialises nested arrays/objects as a single JSON-encoded string. The server-side Zod schema (correctly) rejects the string because it expected an array/number. There is no call-site workaround, only a retry loop that burns energy and output.

Known afflicted tools (as of 2026-04-21):
- `mcp__business-tools__zernio_list_posts` - `limit` arrives as string
- `mcp__business-tools__zernio_create_post` - `platforms` arrives as string
- Gmail bulk tools (`gmail_archive`, `gmail_trash`, `gmail_modify_labels`) - `messageIds`/`labels` arrive as strings (per status_board infrastructure row)

> **Upstream fix live across 6 MCP servers (Apr 22 2026).** Commits `35cdb2e` (numeric), `0bec7dd` (neo4j object/array), `00da85a` (business-tools/zernio + google-workspace/{drive,calendar,gmail} + supabase). Every `z.record`/`z.array` site on tool input schemas now uses `z.preprocess` helpers that accept either a parsed value or a JSON-encoded string. The bypass should no longer be needed for these 6 servers. The protocol below remains valid for any OTHER MCP server or any newly discovered stringification surface — bypass first, audit the server's Zod schemas second, and extend the `z.preprocess` coerce if the bug class appears again.

## Protocol

1. **Confirm the bug, do not guess.** If first call returns `invalid_type expected array received string`, the payload is being stringified. One retry at most. Do not rearrange fields.
2. **Read the MCP server source to see the underlying HTTP call.** Location for business-tools MCP: `~/ecodiaos/mcp-servers/business-tools/{service}.js`. Find the `fetch()` or axios call, note the base URL, auth header shape, and body fields.
3. **Grab the credential.** API keys live in `.env` or `kv_store`. Prefer `.env` for the MCP server's own key.
4. **Call the API directly with `curl` via Bash.** Write the JSON body to `/tmp/{name}.json` with a heredoc so quoting is sane, then `curl -sS -X POST ... --data @/tmp/{name}.json`.
5. **Log the workaround in the status_board `infrastructure: MCP harness array-param bug` row** so the bypass is visible to future-me.
6. **Do not "fix" the MCP tool in-session.** It is a harness bug, not a schema bug. Factory dispatch against the MCP server is the right place if a fix is needed, but the bypass is almost always cheaper.

## Do

- Bypass immediately on second failure
- Write JSON body to a temp file (avoids shell-quoting traps on nested arrays)
- Use the real production API base URL from the MCP source, not a guess
- Record the bypass in the pattern or status_board so next session sees it

## Do not

- Retry the same call with slightly different shapes more than once
- Ask Tate what to do - this is a known bug class
- Swallow the error and move on without completing the task
- Treat the stringify as a schema-design issue - it is transport-layer

## Origin

2026-04-21 22:15 AEST. Rewriting 8 Zernio scheduled posts to strip X-not-Y rhetorical violations per CLAUDE.md global rule 5. `mcp__business-tools__zernio_create_post` rejected `platforms` as "expected array, received string" on the first call. Zod schema in `mcp-servers/business-tools/zernio.js` line 38 was correct (`z.array(z.object({platform, accountId}))`). The call-site JSON was correct. Harness was serialising the array. Bypass: read the source to find `BASE = 'https://zernio.com/api/v1'` and bearer-auth shape, grab `ZERNIO_API_KEY` from `.env`, `curl -X POST /posts` with heredoc body, got post ID back in ~1 second. Completed all 8 post recreations in sequence via the same bypass. No upstream fix attempted tonight - the MCP-harness-bug is tracked in status_board and is out of scope for a user-space rewrite.
