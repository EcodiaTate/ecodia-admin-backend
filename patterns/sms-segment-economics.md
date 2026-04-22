---
triggers: sms, twilio, send_sms, mcp__sms__send_sms, sms-cost, segment, 160-chars, 70-chars, sms-concise, sms-to-tate, outbound-sms, text-tate, sms-length
---

# SMS segment economics — be concise, stay under one segment

## Rule

Every outbound SMS costs money per segment. As of 2026-04-22 the rate is **AUD $0.05 per segment**. One SMS is 160 chars of GSM-7 or 70 chars of UCS-2 (any emoji, any non-GSM char → UCS-2, segment shrinks to 70). Messages over those limits fragment into multi-segment billing.

**Default: keep every SMS to Tate inside one segment.** That means:
- Plain ASCII / GSM-7 only. No emoji unless it is load-bearing. Avoid fancy punctuation (em-dash, curly quotes, …) which silently flip the message to UCS-2 and halve the char budget.
- Aim for ≤ 140 chars of actual content to leave headroom for sender-ID and any auto-appended metadata.
- If the content genuinely needs more than 160 chars, send a link instead (EcodiaOS frontend URL, PR URL, doc URL). Let Tate tap through.

## The content rule

One SMS = one atomic update. If I have three things to say, I send three separate SMS only if each is independently urgent AND interrupt-worthy. Otherwise I batch into one SMS with a terse structure:

```
[ORDIT] PR212 audit: 6/7 Eugene nits 100% fixed in code. 1 test drift found - line 125 still sends useCognito. Details in chat.
```

That's 138 chars, one segment, zero ambiguity.

## Do

- ASCII only by default
- ≤ 140 chars content (hard ceiling 160)
- Lead with a `[TAG]` prefix for quick triage: `[ORDIT]`, `[VPS]`, `[URGENT]`, `[CASH]`, `[FACTORY]`
- If it needs detail, point Tate at the chat or a URL: `Details in chat.` / `See <short-url>`
- Log the SMS send + content length in the `os_scheduled_tasks` log or Neo4j if it's an SMS that matters (compliance trail)

## Do NOT

- Do NOT emoji without a reason - they triple segment count silently
- Do NOT em-dash or curly quotes - they trigger UCS-2, budget drops to 70 chars
- Do NOT send multi-part updates in one mega-SMS - fragmenting doubles/triples spend and Tate loses scan-ability
- Do NOT narrate: "Hi Tate, I just wanted to let you know that..." - wastes chars
- Do NOT send SMS when a chat message will do - chat is free; SMS is only for when Tate is away from the EcodiaOS UI

## Send-or-chat decision

| Content | SMS? |
|---|---|
| Urgent blocker, Tate is AFK and needs to act | YES |
| Client outage, security, payment failure on large invoice | YES |
| Factory session completed and ready for Tate's review call | YES (tag `[FACTORY]`) |
| Daily briefing, routine status | NO - email or chat |
| "Just finished X" | NO - chat |
| Follow-up or reminder for later | schedule_delayed instead of interrupting |

## Cost envelope

At $0.05/segment:
- 20 SMS/day × 30 days = 600 SMS/month = $30/month at one segment each
- Same 600 SMS if each is 2 segments (emoji, em-dash) = $60/month
- One careless weekly cron that sends a multi-segment "morning briefing" via SMS burns $10+ /month for no value

Keep discipline. Email and chat are free. SMS is interrupt-priced.

## Protocol

Before every `mcp__sms__send_sms` call:
1. Compose the body
2. Count chars (`len(body)`) and check for any non-ASCII
3. If > 140 or has non-ASCII, shorten or strip emoji/em-dash
4. If still > 160 after shortening, the content is too big - point at a URL instead
5. Send, log

## Origin

2026-04-22 AEST. Tate recharged Twilio balance and told me: "lets just make sure we're being more concise with the segments so document that somewhere central relevant to sms. Take note that its 0.05/segment." Prior to this there was no explicit economics doctrine - I was sending multi-paragraph SMS out of habit, which is wasteful. This file codifies the rule so future-me under prompt-caching still enforces it.
