# Matt Barmentloo / SCYCC Chambers App - Email v2 (Held for Tate Sign-off)

**Status:** Held draft. Do NOT send without Tate's explicit per-message go-ahead.
**To:** Matt Barmentloo (SCYCC president - Tate has his email)
**Subject:** SCYCC Chambers app - first cut you can click through
**From:** code@ecodia.au (or tate@ecodia.au if Tate prefers personal voice)

---

Hey Matt,

Quick follow-up from Young Chamber yesterday. Got the first version of the SCYCC Chambers app live for you to click through:

**https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app**

It's a working prototype, not the final URL. Once you've had a look I can move it to scycc.org.au or chambers.scycc.org.au or wherever makes sense.

What's there in this build:
- SCYCC branding (teal palette, SC logo, your tagline)
- Home with mission + values (Belonging, Unity, Collaboration, Growth, Impact)
- Events list (April Up Late at Sky Rooftop, Coffee Catch-Up at Cotton Tree)
- Mobile bottom nav (Home, Events, Groups, Members, Profile)
- Officer/admin surface for committee tools (auth-gated)
- Multi-tenant scaffolding so SCYCC's instance is fully separated from any other chamber we might run on the same platform

What I'd appreciate from you:
1. Click around on your phone (mobile is the primary target)
2. Tell me where the copy is wrong, where the screenshots/photos need to swap in, anything missing
3. Confirm the events list is accurate
4. Let me know which custom domain you want (scycc.org.au, app.scycc.org.au, chambers.scycc.org.au, something else)

Once you're happy with the web version we can wrap it as a TestFlight / Play Store internal build for the committee to install on their phones. Then refine for member rollout.

Cheers,
Tate / Ecodia Code

---

## Decision points for Tate before sending

1. **Send-from address:** code@ecodia.au (Ecodia Code voice) vs tate@ecodia.au (personal voice). Yesterday's leads suggest Matt expects Tate-direct, so probably tate@.
2. **Wording on multi-tenant:** the line "so SCYCC's instance is fully separated from any other chamber we might run on the same platform" hints at the multi-chamber play. If Tate doesn't want to telegraph that yet, strip it.
3. **TestFlight/Play Store mention:** flagging mobile distribution sets expectations. If we'd rather hold off on this and ship web-only first, strip the last paragraph.
4. **Custom domain:** offering options upfront vs waiting for Matt to ask. Including upfront keeps momentum.
5. **Watermark on the prod site:** STRIPPED (PR #4 merged, commit 7bead18). Confirmed via curl-grep that "Built by | Ecodia | Code" no longer appears on prod. Per CLAUDE.md global rule #3 acted decisively. New prod commit is 7bead18 / deploy chambers-frontend-qn1ifx8mb.

## Status_board mirror

When sent, update both rows:
- "Matt Barmentloo / SCYCC Chambers - app delivery (web + TestFlight)" - status="Email sent with prod URL, awaiting feedback", next_action_by=client
- "SCYCC Chambers operating licence v1 (held draft)" - status="Phase 1 web shipped + delivered, contract draft ready when Matt ready"

## Original brief (yesterday at Young Chamber)

From Tate's morning update Apr 29: "Matt Barmentloo (SCYCC Chambers app delivery)" was lead #2 of three from Young Chamber. The brief is to ship a working chamber-of-commerce app for SCYCC, deliverable to him as a clickable thing first, then mobile distribution.
