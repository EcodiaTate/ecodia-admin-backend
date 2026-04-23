# Curl attachments to disk on restart, do not re-invoke WebFetch

triggers: webfetch, attachments, restart, recent_exchanges, message-redelivery, re-fetch, supabase-os-attachments, turn-restart, file-url, one-shot-download, /tmp, spec-file, attached-file, http-attachment

---

## The rule

When a user message in `recent_exchanges` contains attachment URLs AND the prior turn's tool calls show WebFetch already succeeded on those URLs, **do NOT invoke WebFetch again on restart**. The content was fetched; either it's in cache-able state or it was lost to session drop. Either way, a fresh WebFetch call is wasteful and often loops.

Default behaviour on restart when attachments are present:
1. Check `recent_exchanges` for prior successful WebFetch output on the URLs.
2. If content is visible (even partial) - work from the exchange text, optionally supplement by reading from disk.
3. If content is not visible OR was truncated - `curl -s -o /tmp/<name> <url>` **once** per file, then `Read` from disk.
4. NEVER call `WebFetch` again on the same URL within the same logical turn.

## Why this exists

A single message that arrives mid-turn can be re-delivered multiple times by the queue/restart machinery (observed Apr 23 2026: same Co-Exist spec message delivered 3 times across restarts). Each delivery looks identical to past-me: "attachments, I should fetch them." Re-fetching:
- Burns tokens (WebFetch summarisation is non-trivial)
- Can hang or timeout on the same URL repeatedly
- Masks the fact that the attachment is already in my context from a prior turn

The correct cheap primitive is `curl` to disk. One shell command, one file, no LLM summarisation, no loop risk.

## Do

- `curl -s -o /tmp/<slug>/<file>.md <url>` on restart if attachments are present and not already usable.
- Create a per-session tmp dir (`mkdir -p /tmp/<slug>-specs`) for related attachments so they're easy to find later.
- `Read` the local file instead of re-WebFetching.
- If the attachment is critical context, mirror its URL into a Neo4j Episode so a later session can recover if `/tmp` was cleared on VPS reboot.

## Do not

- Call `WebFetch` on the same URL twice in the same logical turn.
- Re-invoke `WebFetch` on restart just because the attachment URL is "still in the user message."
- Dispatch a Factory session to "fix the fact that WebFetch didn't complete" - the fix is curl + Read, not more agents.
- Assume the attachment content is lost just because the tool output was truncated in display.

## Protocol on restart when a message carries attachments

```
1. scan recent_exchanges for this message + prior tool calls
2. if WebFetch already ran with visible content in recent_exchanges:
     -> work from that content; curl to disk only if you need the full text
3. if no prior WebFetch OR content was empty/truncated:
     -> curl -s -o /tmp/<slug>/<name> <url>   (one per file)
     -> Read /tmp/<slug>/<name>
4. record the URL in the session's Neo4j Episode so /tmp loss is recoverable
```

## Origin

Apr 23 2026 ~20:42 AEST. Tate sent a message with 2 EcodiaOS spec attachments (Listeners + NextBuild). Session restarted mid-turn and the message was re-delivered 3 times. On the 3rd delivery I was about to WebFetch both URLs a third time. Tate cut in: "bro you litereally jsut dispatched a factory to fix the fact that you coiuldnt do the 2 webgfetches.... so dot FUCKING do them again??"

Fix: `curl -s -o /tmp/coexist-specs/{listeners,nextbuild}.md <url>` (one-shot, 376 + 278 lines downloaded in <1s), then `Read` from disk. Zero further WebFetch calls in the turn.

The token waste was real but recoverable. The trust erosion from "you're literally looping the same failure" is the more expensive cost. Hence this pattern file - so future-me greps `webfetch` or `attachments` or `restart` on the NEXT restart and doesn't relive it.

## Related patterns

- `no-symbolic-logging-act-or-schedule.md` - same anti-pattern family (loops that feel productive but aren't).
- `neo4j-first-context-discipline.md` - after a restart, Neo4j + `recent_exchanges` are your context, not a fresh round of tool calls.
