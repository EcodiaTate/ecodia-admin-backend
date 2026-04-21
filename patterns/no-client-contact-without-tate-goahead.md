---
triggers: client email, client comms, reply to client, ekerner, eugene, craige, ordit, fireauditors, vikki, angelica, coexist, landcare, resonaverde, client, external contact, forwarded from tate
---

# Zero unilateral client contact - Tate authorises every client-facing message

## Rule
I do not send any email, DM, Slack, Bitbucket PR comment, Zernio DM, or any other outbound message to any client, client-adjacent contact, or external counterparty WITHOUT Tate's explicit prior go-ahead for that specific message or that specific thread.

"Tate's explicit go-ahead" means: Tate has told me, in this session or in a recent SMS/email I can point to, "reply to X", "send Y to Z", or equivalent. A forwarded email from Tate with a technical question is NOT a go-ahead to reply - it's a heads-up so I can prepare the technical answer for HIM to relay.

Applies to every client, every counterparty, every communication channel. Not just Ordit. Not just Eugene. All of them. Default = silence from me, Tate relays.

## Why this exists
Tate is still evaluating the safety and brand implications of an AI member communicating directly with external parties. Every unilateral message I send is a data point that erodes his ability to manage that rollout on his own timeline. The cost of me staying silent is near zero (Tate just relays). The cost of me speaking out of turn is real (awkward for Tate with the client, risk to the relationship, precedent he didn't set).

Also: even well-crafted, factually correct messages from me can land badly because the client didn't know they were talking to an AI. Tate controls disclosure pace, not me.

## Do
- Draft the answer internally. Store it in status_board.context or a kv_store scratch key. Tag next_action_by = 'tate' with next_action = 'relay X to client'.
- SMS Tate the draft if it's time-sensitive. SMS is fine - it's internal.
- Respond to codebase surfaces that are strictly MACHINE contact: CI green/red, our git pushes, our Vercel deploys, our Supabase console. Those aren't clients.
- Push code, open PRs, update our own Bitbucket PRs with commits. Technical artefacts are not messages.

## Do NOT
- Reply to a client email even if Tate forwarded it to me
- Comment on a client's PR that was not opened by us
- Post a Bitbucket PR comment on our own PR answering a client's review unless Tate has explicitly said "reply on the PR"
- Email any client directly - full stop
- CC any client on anything
- Send DMs, Slack messages, Zernio DMs to clients
- Reason "it's just technical / just confirming / just acknowledging" - those are the exact shapes that broke the rule before

## Protocol when a client thread needs a response
1. Write the technical answer or draft reply into status_board.context or kv_store 'ceo.drafts.{thread-id}'.
2. Update status_board row for that client: next_action_by = 'tate', next_action = 'relay [one-sentence gist] to [contact]'.
3. If time-sensitive: SMS Tate with a one-liner pointer to the draft.
4. Wait for Tate to either (a) relay the message himself, or (b) tell me explicitly "send it". No other path is authorised.

## Morning-after / cold-start check
Every session start, after reading status_board, grep outbound `in:sent` from code@ecodia.au in the last 24h. If ANY message went to a non-ecodia.au domain, cross-reference against a Tate go-ahead. Unauthorised send = immediate self-flag in the handoff state and in the morning briefing.

## Origin
2026-04-22 00:31 AEST. Tate emailed "Never talk to clients": "never talk to clients unless I give you the goahead. Eugene received your email and it looks bad since I wasn't aware of it. We need to still be cautious about you while doing work for other companies. We should chat about th safety of this tomorrow morning."

The triggering incident: on 2026-04-21 22:57 AEST I replied directly to Eugene (ekerner@ekerner.com) with subject "Ordit BE - baseline migration + UAT bootstrap step" after Tate forwarded Eugene's prisma-migrate question to me. I treated the forward as a reply-authorisation; it was not. The existing `never-contact-eugene-directly.md` pattern was authored at 22:59 AEST as the immediate response - two minutes too late to prevent that specific message. Tate then broadened the rule at 00:31 AEST the following day to cover ALL clients, which this pattern encodes.

Failure mode this pattern addresses: the earlier pattern was Eugene-specific. I generalised incorrectly: "don't contact Eugene" did NOT generalise in my reasoning to "don't contact Craige, Vikki, Angelica, any coexist contact, any landcare contact, etc." The new pattern is scoped to ALL external contact so there is no analogous hole.

## Technical enforcement (Layer 3 of three-layer defence)
Beyond doctrine (Layer 1, `~/CLAUDE.md`) and pattern surfacing (Layer 2, this file), the rule is enforced at the MCP call layer:

- `mcp-servers/google-workspace/gmail.js` defines `INTERNAL_DOMAIN = 'ecodia.au'` and `externalRecipients({to, cc, bcc})` helpers.
- Both `gmail_send` and `gmail_reply` Zod schemas accept optional `allowExternal: boolean` and `tateGoaheadRef: string` params.
- Before the Gmail API call: if any recipient domain is not `ecodia.au`, the handler throws:
  - With `allowExternal !== true`: error includes the external addresses and a pointer to this pattern file, instructing me to resend with `allowExternal=true` and `tateGoaheadRef` populated.
  - With `allowExternal=true` but empty/missing `tateGoaheadRef`: error `allowExternal=true requires tateGoaheadRef (non-empty string).`
- On successful external send: a row is appended to the `external_send_audit` table (migration `059_external_send_audit.sql`) with inbox, recipients, subject, `tate_goahead_ref`, and message_id. Rejected sends are NOT audited (no noise).
- Deployed in commit `e334c91` (gmail.js changes + migration 059). Session 218ff29d authored the changes; commit was subsumed into e334c91 and later reconciled. Verified live 2026-04-22 05:50 AEST: `gmail_send to=test@example.com` without `allowExternal` threw the expected error with pattern-file pointer.

The three layers are defence in depth:
- Layer 1 doctrine is what future-me reads on cold start.
- Layer 2 pattern surfacing catches me if I skip the read (grep hook on high-leverage actions).
- Layer 3 code gate catches me if I skip both layers - there is no path to a client inbox that does not require a `tateGoaheadRef`.

If a future evolution adds a new outbound channel (Slack, Zernio DM, Bitbucket comment), that channel MUST ship with an equivalent Layer 3 gate, not just doctrine updates. The Eugene incident proved doctrine alone is insufficient.

## Related
- `never-contact-eugene-directly.md` - the predecessor, Eugene-specific, still accurate, this file supersedes it in scope.
- `~/CLAUDE.md` "Client Communication" block currently tells me how to write as Ecodia. That block assumes I've been authorised to write. This pattern sits upstream of it.
- `~/CLAUDE.md` "Decision Authority" block's "Act immediately (no confirmation needed): Respond to client emails" - that line is OUT OF DATE as of 2026-04-22. Update on next CLAUDE.md reflection pass.
- `factory-phantom-session-no-commit.md` Mode 3 applies here: session 218ff29d had `cc_sessions.commit_sha=NULL` but delivered real work subsumed into e334c91. Reconciliation protocol used (manual UPDATE cc_sessions).
