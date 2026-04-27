---
triggers: co-exist, coexist, kurt, platform, multi-tenant, peak body, peak-body, landcare, federation, multiplier thesis, conservation platform, white-label, rebrand, generalise, generic platform, tenant-0
---

# Co-Exist app belongs to Kurt; the platform underneath is ours - keep the IP separation explicit

The Co-Exist app and the Co-Exist brand are the property of **Co-Exist Australia (Kurt's charity)**. They are NOT Ecodia property. Ecodia owns the underlying platform code patterns and infrastructure that currently power Co-Exist as the lighthouse deployment, but the platform needs a **rebranded / generalised product name** before being pitched to any other peak body (Landcare, NRM regions, councils, etc.).

**The drift this fixes:** writing about "Platform-Co-Exist", "Co-Exist multi-tenant federation", or "the Co-Exist platform" as if Co-Exist is the product Ecodia sells. It isn't. Co-Exist is a deployment of our platform under their brand. Talking about it the wrong way implies we have rights we don't have, and confuses prospective peak-body buyers.

## The rule

| Layer | Owner | Brand | Sellable to others? |
|-------|-------|-------|---------------------|
| The Co-Exist app, brand, content, charity activities | Co-Exist Australia (Kurt's charity) | Co-Exist | No - it's their app |
| The underlying platform code (multi-tenant patterns, Edge Functions, sync engines, admin UI patterns, deployment automation) | Ecodia Labs Pty Ltd | TBD - rebrand pending | Yes - this is what we sell |
| The lighthouse deployment proving the platform works at production scale | Joint - app is theirs, platform underneath is ours | Co-Exist (their brand on a stack we own) | Reference case study only, anonymised by default per public-writing doctrine |

## Do

- Refer to what we sell as "the underlying conservation platform (working name pending)" or "the platform underneath Co-Exist" until Tate names it.
- When discussing pricing for peak bodies, talk about platform tiers, NOT "Co-Exist tiers".
- Reference Co-Exist as a case study / lighthouse deployment, anonymised by default (peak-body anchor, youth-conservation-app client, etc.) per the public-writing doctrine in `~/CLAUDE.md`.
- Maintain the IP separation in every artefact: status_board rows, kv_store briefs, Neo4j Strategic_Direction descriptions, pitch decks, contracts, social posts.
- When Tate names the rebranded product, do a sweep across every artefact and replace the placeholder with the new name in one pass.
- Internally, the IP-license chain is Ecodia Labs Pty Ltd → Ecodia Pty Ltd. Client contracts attribute IP to Ecodia Pty Ltd (per IP retention doctrine). Co-Exist's licence covers their app/deployment specifically.

## Do not

- Write "Platform-Co-Exist" / "Co-Exist platform" / "Co-Exist multi-tenant federation" as if Co-Exist is the platform brand. It is the app brand only.
- Pitch "Co-Exist" to other peak bodies. Pitch the platform underneath, under a TBD brand.
- Imply we can sell, sublicense, or modify the Co-Exist app, brand, or charity content to anyone else. We can't.
- Drift back into the conflated framing in pitch decks or briefs because the existing kv_store briefs use "platform-coexist-*" keys. The keys are fine as internal pointers but the *content* needs a rewrite pass before any external artefact ships.
- Pick a new brand name for the platform without Tate. That's a creative call he owns.

## Verification protocol

Before any artefact mentioning the platform leaves the building (pitch deck, email, post, contract, deck for a peak body):

1. Grep the artefact for "Co-Exist" / "Platform-Co-Exist" / "Co-Exist platform". Each hit must be either (a) a deliberate, anonymised case-study reference to Co-Exist Australia's deployment, or (b) deleted/replaced with the platform's working name.
2. Check that ownership statements attribute the platform to Ecodia and the app/brand to Co-Exist Australia. No collapsing.
3. If the platform name is still TBD, the placeholder used in v0.x drafts must be flagged in a "names pending" section so Tate can stamp it before v1.

## Affected artefacts as of 2026-04-27

- status_board rows `6bd9d3b5` and `7d83ef0c` renamed from "Platform-Co-Exist" to "Conservation platform (working name pending)" with explicit IP-separation language in status + context.
- kv_store keys still using `platform-coexist-*` naming - keep keys (they're internal pointers) but rewrite *content* IP language before any external artefact derives from them: `ceo.briefs.platform-coexist-pricing-benchmarks-2026-04-25`, `ceo.briefs.platform-coexist-federation-thesis-2026-04-26`, `ceo.drafts.platform-coexist-peak-bodies-brief-v1`, `ceo.audit.coexist-multitenant-readiness-2026-04-25`.
- Neo4j Strategic_Direction nodes "Platform-Co-Exist for peak bodies - Multiplier Thesis" and "Co-Exist as Conservation NGO Platform (the Multiplier Thesis)" - need rewrite pass to make the IP separation explicit.
- Any pitch deck draft referring to a "Platform-Co-Exist tier" or "Co-Exist multi-tenant federation" - blocked on rebrand pass before shipping.

## Origin

2026-04-27 ~10:04 AEST. Tate flagged the IP language drift across multiple drafts and status_board rows. His exact words: "Co-Exist is the property of Co-Exist Australia which is Kurt's Charity, in some of your plans its getting convoluted and you make it sound as tho its our or that the co-exist platform is ours to work with which it isnt... the Code patterns ARE, but we need to rebran/generalise it." The drift had been building since the Apr 23 Multiplier Thesis was first crystallised, where the peak-body-anchor framing kept getting written as "Platform-Co-Exist" instead of "platform we own, deployed at Co-Exist as lighthouse". Pattern logged so any future cron loop or session that touches platform pricing, peak-body outreach, or brand decisions surfaces this rule before drafting.
