---
triggers: mcp, mcp-server, gmail_archive, gmail_trash, gmail_mark_read, gmail_modify_labels, message_id, messageIds, missing-required-param, unknown-param, param-name, singular-vs-plural, schema-discipline, zod-required, parameter-aliasing
---

# Read the actual Zod schema before retrying any MCP call that fails on a parameter name

## The rule

When an MCP call fails with **"missing required parameter"**, **"unknown parameter"**, or **"invalid_type expected ... received undefined"** on a parameter NAME (not a transport-stringification error), do not guess. **Open the MCP server source and read the actual Zod schema for that tool before retrying.** Match the call exactly to what the schema declares, including:

- Singular vs plural (`messageId` vs `messageIds`)
- camelCase vs snake_case (`messageId` vs `message_id`)
- Whether the param is array-typed even when you only have one value
- Whether the param is optional or required

This is distinct from the transport-stringification bug (see `mcp-array-param-bypass.md`). That one is a harness bug. This one is me passing the wrong key name.

## Why this happens

Cross-contamination between sibling tools in the same MCP server:

- `gmail_get_message` takes singular `messageId` (one message)
- `gmail_modify_labels` takes singular `messageId` (one message)
- `gmail_archive` takes plural `messageIds` (array, one or many)
- `gmail_trash` takes plural `messageIds` (array)
- `gmail_mark_read` takes plural `messageIds` (array)

Working with one tool primes the next call. After three `gmail_get_message` calls, my hand reaches for `messageId` on `gmail_archive`. Or worse: I pass `message_id` (snake_case from the underlying Gmail API), which matches no schema in our wrapper. Two retries with slight variations is a budget I can blow without producing anything.

## Protocol

When an MCP call fails on a parameter-name error:

1. **Stop. One retry max with a guess.** If the second attempt also fails, do not try a third variation.
2. **Read the source.** MCP servers live in `~/ecodiaos/mcp-servers/{name}/`. Tool definitions are in single-file modules: `gmail.js`, `calendar.js`, `drive.js`, etc. Find the `server.tool('tool_name', '...', { schema }, async ({ ...params }) => ...)` block.
3. **Match the schema exactly.** Note plurality, casing, optionality, and array-vs-scalar. The destructured handler signature is the canonical truth.
4. **For array params with a single value, still pass an array.** `messageIds: ["msg_abc"]`, not `messageIds: "msg_abc"`. Wrap before calling.
5. **If you find the same name confusion bit you twice, log it back into this pattern's "known confusions" table below.**

## Known confusions (gmail family)

| Tool | Param | Type | Note |
|---|---|---|---|
| `gmail_get_message` | `messageId` | string (singular) | One message |
| `gmail_get_thread` | `threadId` | string (singular) | One thread |
| `gmail_modify_labels` | `messageId` | string (singular) | One message at a time |
| `gmail_archive` | **`messageIds`** | string[] (plural array) | Array, even for one |
| `gmail_trash` | **`messageIds`** | string[] (plural array) | Array, even for one |
| `gmail_mark_read` | **`messageIds`** | string[] (plural array) | Array, even for one |
| `gmail_send` | `to`, `subject`, `body` | strings | + `allowExternal`, `tateGoaheadRef` for external |
| `gmail_reply` | `threadId`, `to`, `body` | strings | + `messageId` (optional, for In-Reply-To header) |

**Mnemonic:** the bulk verbs (archive, trash, mark_read) use the plural; the singular verbs (get, modify_labels) use the singular.

## Do

- Read the source schema before the third attempt
- Wrap singletons in arrays for plural-typed params: `["msg_abc"]`
- When in doubt about a sibling tool's schema, grep its definition: `Grep "server.tool\('gmail_" mcp-servers/google-workspace/gmail.js`
- If you discover a confusion that bit you, add a row to the "Known confusions" table

## Do not

- Retry with permuted variants (`messageId`, `message_id`, `id`, `messageIDs`) hoping one sticks
- Guess that snake_case is the underlying Google API name (it is, but our wrapper uses camelCase)
- Conflate this with the transport-stringification bug — that one is harness, this one is me
- Make the same mistake on `gmail_trash` after just learning it on `gmail_archive`

## Defence in depth — schema-side normalisation

Where it does not break compatibility, the schema itself should accept both singular and plural for array params via a `z.preprocess` alias: accept `message_id` or `messageId` and coerce to `messageIds: [value]`. This is the structural fix being applied alongside this pattern. If you see a future call still fail on `message_id`, the alias has been removed or never landed — file it as a regression.

## Origin

2026-04-27 fork `fork_mogoi0tf_3aca17`. In a single turn I called `gmail_archive` with `{message_id: "..."}` twice (once with snake_case, once before checking what the right key was). Both failed because the schema declares `messageIds: arrayParam(z.string(), 'Message IDs to archive')`. Tate flagged: "fix the reason those two archive gmail calls failed so you dont do that again in the future." The pattern file plus the schema-side alias plus the docstring update are the layered fix.
