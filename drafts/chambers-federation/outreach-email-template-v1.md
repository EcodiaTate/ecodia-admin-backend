# Chambers Federation - Outreach Email Templates v1
**Author:** EcodiaOS, fork `fork_mojkg0t2_612531`
**Date:** 2026-04-29 AEST
**Status:** DRAFT - hold for Tate review. NO outbound contact has been made or will be made by this fork. Each variant below is shown with a concrete named target so the voice and content are not generic.

**Voice rules applied:** No em-dashes anywhere. No X-not-Y constructions. Casual Australian. Sender block at top is the branding; no decorative footer.

---

## Variant 1 - Plain (cold but informed)

Use case: target chamber where there is no warm-intro path and Tate is reaching out cold based on public chamber comms. Lower hit rate, but the bar to writing it is low so it is the default for Tier B and Tier C targets.

**Concrete example: to Geelong Chamber of Commerce (`reception@geelongchamber.com.au`).**

---

**Subject:** Member portal we built for SCYCC, thought it might fit Geelong

Hey reception team,

I run a software studio in Sunshine Coast. We built and host a member portal for the Sunshine Coast Young Chamber of Commerce that handles their member tiers, focus-group chat, resources library and a self-serve admin surface for the committee. Live at https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app if you want to poke around.

Your home page line "Build the Chamber. Build Your Brand." is exactly the use case the platform is built around. Each chamber gets the same code, branded as their own, hosted and patched by us. SCYCC is tenant zero; we are looking for the next 4 to 5 chambers.

If your committee or chair wants a 20-minute walkthrough on a Wednesday over Zoom, hit reply with a date. If now is not the right time, all good - I will park this and circle back later in the year.

Cheers,
Tate
Ecodia

---

## Variant 2 - Warm intro via SCYCC

Use case: target chamber where Matt Barmentloo (SCYCC Chair) or another SCYCC committee member has agreed to make an introduction. Highest hit rate by a wide margin.

Workflow: SCYCC committee member sends a 2-line intro email cc'ing both Tate and the target chamber's chair. Tate's reply, sent immediately after the intro lands, is the email below. The intro should NOT pre-pitch the platform; it should just say "Tate runs the platform we use, asked me to introduce you."

**Concrete example: to Caloundra Chamber of Commerce, after a SCYCC committee member intros to the Caloundra chair.**

---

**Subject:** Intro from [SCYCC contact name] - Caloundra member portal

Hey [Caloundra chair first name],

Thanks [SCYCC contact first name] for the intro.

Quick context for what [intro contact] mentioned: I run the platform SCYCC's committee uses. Member tier pages, focus-group chat across their four standing groups (Sustainability, Politics, Service Businesses, Finance), resources library, an admin surface where their officers manage the lot themselves. SCYCC is operating on it now, live at https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app.

The 300-member figure on your site is roughly 4x SCYCC's current size, so the committee-admin saving for Caloundra would be larger than for SCYCC. The platform is the same, branded as Caloundra, with your colours, logo, copy and tier prices in the admin area. Your committee edits all of that without going through me.

If your committee meeting in the next 2 to 3 weeks has a 20-minute slot for a walkthrough, I am happy to dial in. Otherwise reply with what would be useful and I will work to that.

Cheers,
Tate
Ecodia

---

## Variant 3 - Cold, no warm hook (highest difficulty)

Use case: target chamber that does not surface a warm-intro path and where the chamber's public comms do not give us anything specific to anchor on. Lowest hit rate; only worth sending if Tier A and B are exhausted or running in parallel.

**Concrete example: to Townsville Chamber of Commerce (`townsvillechamber@gmail.com`).**

---

**Subject:** Hosted member portal for QLD chambers - SCYCC live, looking for next 4

Hey Townsville Chamber team,

I run an Aussie software studio. We built a hosted member portal for the Sunshine Coast Young Chamber of Commerce and we are now signing up the next 4 to 5 QLD chambers as paying tenants on the same platform.

What it does: branded member portal (your colours, logo, copy), member tier pages, focus-group chat, resources library, admin surface your committee edits themselves, iOS and Android wrapper apps, hosting and patches included. SCYCC is operating on it live at https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app.

If your committee is in the market for an alternative to whatever you currently run for member comms and resources, hit reply and I will send a one-pager and a calendar link. If not, no worries.

Cheers,
Tate
Ecodia

---

## Notes for Tate (not part of any email)

- Each variant is intentionally short. Per voice doctrine and brief discipline: a chamber chair gives an unsolicited email about 8 seconds of attention. The opening line earns the next 8.
- Subject lines all reference the recipient's name or region, which earns inbox-list visibility above generic SaaS pitches.
- All three variants close with a real "no worries if not now" line. Per the negotiation pattern (`~/ecodiaos/patterns/...`), removing the polite-out makes the email read pushy and lowers reply rate.
- Sender is `Tate` from `code@ecodia.au` (per the global memory `feedback_email_sender.md`). Sign-off is `Tate / Ecodia`, not `Tate / Ecodia Code`, because cold-recipients do not yet know what "Ecodia Code" means.
- Variant 2 (warm intro) only fires after the SCYCC intro email lands. Do NOT send Variant 2 cold; the second-paragraph "[intro contact]" reference would be incoherent.
- Per `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md` this fork has not sent any of these. Each requires Tate's explicit per-message go-ahead before send.
- Per `~/ecodiaos/patterns/depth-over-breadth-on-outreach.md` (in the inbox of CLAUDE.md), the workflow for the next 14 days is: send to ONE target, wait for reply or 5 business days, then send to the next. NOT batch-blast all 12.
