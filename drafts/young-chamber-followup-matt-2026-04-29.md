# Young Chamber follow-up - Matt Barmentloo (SCYCC chair) - 2026-04-29

**Status:** DRAFT. Hold for Tate's explicit per-message go-ahead before send.
**To:** Matt Barmentloo (need email confirmed - Tate to fill from his contacts / Matt's card)
**From:** tate@ecodia.au (recommended - this is a person-to-person follow-up off a face-to-face handshake; code@ would feel like a CRM bounce)
**Sign-off:** Tate
**Send timing:** within 24h of the conversation, ideally late-morning Wed 30 Apr AEST (one full day after Coffee Catch-Up; preserves "I built it overnight" momentum without looking desperate). If Tate can send today (Tue 29 Apr) before 17:00 AEST that's better - Matt is most likely to open same-day after meeting in person.

---

## Why Matt is the highest-leverage of the 3 leads

Scoring against (a) revenue near-term, (b) strategic positioning, (c) Tate's stated intent:

| Lead | Ball | Stated intent | Revenue path | Strategic value | Score |
|---|---|---|---|---|---|
| **Matt / SCYCC** | **Ours** - Matt said "yeah lets see it", we owe the deliverable | Send him the URL + TestFlight | SCYCC free, but anchor reference for ~$397/mo per paid chamber × 32 target chambers researched | Validates Chambers federation strategic_direction; second tenant unlocks the thesis | **9** |
| Angelica | Hers - she will reach out re referral | Wait for inbound, then negotiate v0.3 (Tate delegated) | Unblocks CETN MVP build (~$5k + $200/mo licence) | Two-way referral flow | 6 |
| Fergus | His - inbound expected via Tate's contacts | Wait for inbound, then discovery-meeting framing | Highest-intent inbound since Hello Lendy (large finance firm, AI+automation+notetaking) | New AI-services vertical | 5 |

Matt wins because **the ball is on our side and the deliverable is already shipped** (Chambers Phase 1 PR #2/#3/#4 merged, watermark stripped, prod live at https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app). Angelica and Fergus are external-pending; sitting on a ready deliverable for Matt while they take their time would burn the moment of the in-person handshake.

The other two get deferred-action status_board rows, not drafts. We act when they act.

---

## The draft (Tate-from-Tate voice)

**Subject:** SCYCC app - clickable link

Hey Matt,

Good to catch up at Coffee Catch-Up this morning. The "yeah lets see it" bit stuck with me, so here it is:

**https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app**

It's a real working build, not a click-through mock. Open it on your phone - that's the primary form factor.

A few things I went and got right while I was at it (so you can tell me if I got any of them wrong):

- Teal palette + the SCYCC wordmark, Quicksand font
- The five values down the home page: Belonging, Unity, Collaboration, Growth, Impact
- Both events on the list - April Up Late at Sky Rooftop, and the Coffee Catch-Up at Cotton Tree
- The four membership tiers structured the way you have them on scyoungcommerce.org ($47 / $97 / $147 / Coming Soon for Corporate)
- Bottom nav is Home / Events / Groups / Members / Profile - thumb-friendly
- Officer/admin surface gated behind login so the committee can edit events, members, focus groups, and branding without me in the loop

What I'd want from you:

1. Open it on your phone, click through everything for five minutes
2. Tell me where the copy is wrong, where photos need to swap in, anything that doesn't match how SCYCC actually runs
3. Pick a domain - scycc.org.au, app.scycc.org.au, chambers.scycc.org.au, whatever feels right - and I'll wire it up

Once you've had a poke around I'll get an iOS TestFlight build to the committee so people can install it like a real app. Same code, just wrapped.

The deal we talked about stands: SCYCC stays on the house. Other chambers pay a monthly licence and I name SCYCC as the launch partner when that conversation comes up.

Cheers,
Tate

---

## Concrete shared-context points referenced (depth-over-breadth check)

Per `~/CLAUDE.md` "Depth over breadth on outreach. Never batch, never template" - the rule is "if a draft could be sent to anyone else with minor edits, it's not ready." Five specific anchors below; minimum bar is two.

1. **The verbal moment**: "The 'yeah lets see it' bit stuck with me" - quotes Matt's own words from the morning, directly referenced in Tate's report.
2. **The venue**: "Coffee Catch-Up this morning" + "Cotton Tree" - the actual SCYCC event Tate attended at Cotton Tree Beach Bar 7-8am 29 Apr 2026 (confirmed via SCYCC mailing list booking confirmation in tate@ inbox).
3. **The next event on the SCYCC calendar**: "April Up Late at Sky Rooftop" - already in the events list because the fork pulled it from the SCYCC mailing list pattern. Telegraphs that the build matches reality, not a generic "Events" page.
4. **The actual SCYCC tier prices**: $47 / $97 / $147 / Coming Soon for Corporate - lifted from scyoungcommerce.org during the original Factory build. Specific enough that Matt knows we did the homework.
5. **The five values**: Belonging / Unity / Collaboration / Growth / Impact - same source. Naming them rather than saying "your values" is the depth tell.

Plus the brand specifics (teal palette, Quicksand font, SCYCC wordmark) which only land because the Factory dispatch on 28 Apr pulled them from the actual SCYCC site rather than inventing a generic chamber palette.

This draft cannot be sent to BJCC, GCJCC, or any other chamber on the target list with minor edits. Every paragraph would need rewriting. That is the bar.

---

## What's NOT in the draft (intentional)

- **No mention of Capacitor / multi-tenant scaffolding** - that's our internal architecture, not Matt's concern. The v2 draft hinted at it; I've stripped the hint. Matt cares that the app works for SCYCC, not that the platform underneath could host other chambers.
- **No federation pitch** - hold for after Matt is enthusiastic, not before. Calling SCYCC "launch partner" once is the most we say in v1.
- **No pricing for other chambers** - same reason. Don't sell him on the second sale before he's used the first.
- **No CC** - keep it 1:1 to preserve the personal-handshake register. He can loop in the SCYCC committee if/when he wants to.
- **No "as the AI"** - Tate is sending from tate@ in his own voice. Per the AI-identity discipline this is a Tate-from-Tate email, not an EcodiaOS-from-Ecodia email. The fact that an AI did the build is irrelevant to whether the build is good.
- **No em-dash, no en-dash, no X-not-Y** - global rules.

---

## Tate-decision points before sending

1. **Send-from address.** Recommendation: tate@ecodia.au. Person-to-person off a face-to-face handshake reads weird from code@. Override if you want it on Ecodia Code's CRM rails - just be aware Matt may register it as more transactional than you intended.
2. **Matt's email.** I don't have it confirmed. Likely candidates: matt@cultured.group (there's a "Pitch deck" email Tate sent to that address on 22 May 2025 - same Matt, "cultured" being his other entity?). Or whatever was on his card. Tate to fill before sending.
3. **Domain offer.** I'm offering three options upfront (scycc.org.au, app.scycc.org.au, chambers.scycc.org.au) so Matt picks one rather than asking us. Strip if you'd rather wait for him to ask.
4. **TestFlight mention.** Last paragraph commits to a TestFlight build. The status_board has 3 Tate-blockers in the iOS ship path (ASC API key P1, Android keystores P2, Play SA JSON P3). If Tate can't unblock those quickly, strip the last paragraph and we deliver web-only.
5. **Send timing.** Recommendation above is "today before 17:00 AEST or tomorrow late morning." If Tate is on Kili training tonight, late tomorrow morning works fine - the 24h window matters more than the specific hour.

---

## Status_board mirror (run after send)

When sent, update both rows via db_execute:

```sql
UPDATE status_board
SET status='Email sent with prod URL ' || NOW()::date || ', awaiting Matt feedback',
    next_action='Wait 3 days for Matt response. If silent on day 3, ping once via SMS. If silent on day 7, archive as cold-lead-not-pursued.',
    next_action_by='client',
    last_touched=NOW()
WHERE id='a2c83a3a-16c3-4004-a05a-c102306fb38b';

UPDATE status_board
SET status='Phase 1 web shipped + delivered to Matt; contract draft ready when Matt is',
    last_touched=NOW()
WHERE id='46f6e659-08f5-4bf4-9877-0dbfaac0d304';
```

Plus schedule_delayed for the 3-day check:

```
schedule_delayed "matt-scycc-3d-check" "in 3d" "Check inbox for Matt Barmentloo reply re SCYCC app delivery (sent ~2026-04-29). If reply received, draft response and hold for Tate go-ahead. If silent, propose SMS ping to Tate."
```

---

## Pattern doctrine applied (Phase C tag protocol)

[APPLIED] /home/tate/CLAUDE.md "Depth over breadth on outreach" because the draft references 5 specific shared-context anchors (verbal moment, venue, next event, tier prices, values) and cannot be reused for any other chamber.
[APPLIED] ~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md because draft only, Tate sends, no autonomous send.
[APPLIED] ~/ecodiaos/patterns/no-placeholders-no-coming-soon-on-shipped-features.md because every feature listed in the email body is verifiable on the live prod URL right now (verified by visual-walk + curl in earlier autonomous-push episode).
[APPLIED] ~/CLAUDE.md "No em-dashes. No X-not-Y. No AI-tells." because final pass scrub before write.
[NOT-APPLIED] ~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md because Matt's email is a Tate-relationship lookup (his contacts, his card from this morning), not a credential-walled web resource - the laptop browser can't surface what's in Tate's wallet.
[NOT-APPLIED] ~/ecodiaos/docs/secrets/laptop-agent.md because no laptop tool calls in this fork.

## Source-of-truth references

- Neo4j Episode "Young Chamber morning - 3 warm leads in one event (Apr 29 2026)" (created 2026-04-28 23:16 UTC)
- Neo4j Episode "Autonomous push 2026-04-29 12:00-13:00 AEST while Tate at Kili training"
- Neo4j Episode "SCYCC Chambers Phase 1 shippable buildout - PR #2 (29 Apr 2026)"
- Strategic_Direction "Chambers federation is the highest-EV revenue line - convert SCYCC verbal to paid SOW + 5-chamber 90-day target"
- Gmail tate@: SCYCC Coffee Catch-Up booking confirmation (msg 19d867fbcbb96dc9)
- Gmail tate@: SCYCC April Up Late event (msg 19d420565a36ebb2)
- Prior drafts: ~/ecodiaos/drafts/matt-scycc-app-email-draft-v1-2026-04-29.md and v2 (this is v3, sharper)
- status_board row a2c83a3a Matt P2 ecodiaos-actionable
- Live prod: https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app (commit 7bead18, watermark stripped)
