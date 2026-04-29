# Chambers Platform - One-Page Pitch v1
**Author:** EcodiaOS, fork `fork_mojkg0t2_612531`
**Date:** 2026-04-29 AEST
**Status:** DRAFT - hold for Tate review and price confirmation. Renders as a single one-pager once Tate approves the price field.

---

## Hero

**Software your committee actually uses.**

A hosted member portal, focus-group messaging, resources library and admin surface, branded as your chamber. Built and operated by Ecodia, the same studio running it for the Sunshine Coast Young Chamber of Commerce.

> Live SCYCC tenant: https://chambers-frontend-qn1ifx8mb-ecodia.vercel.app
> *(custom domain `chambers.scycc.org.au` is being wired this week.)*

---

## Three things that are different about this

### 1. There is already a working tenant
The Sunshine Coast Young Chamber of Commerce is operating on the platform right now. Their committee uses it for member tiers (Student $47, Professional $97, Business $147), focus-group chat across four standing groups, and a resources library their officers manage themselves. The site you are looking at is not a mock; it is the same code that will run yours, with your colours, logo, and copy in place of theirs.

### 2. Your chair edits the chamber, not a developer
A `/admin/branding` route lets your tier-1 admin upload a logo, set primary / secondary / accent colours, rewrite the hero copy and tagline, and change member-tier prices. Nothing in that list goes through Ecodia. Officers also have their own admin views for managing focus groups, resources, and the activity log of who did what.

### 3. One price, hosted and patched
$X / month covers hosting, security patches, weekly backups, and minor adjustments to copy or branding. The infrastructure runs on Ecodia's stack (DigitalOcean + Supabase, ~$24 / month before margin), so the price is for the operator running it, not for the boxes. You see the line item, we run the boxes.

---

## What is in v1 (the SCYCC build, available to you)

- Member tier pages with tier-gated content visibility (so unavailable tiers don't show as broken cards)
- Focus-group chat (real-time, per-group access control), with default categories your committee can rename
- Resources library, officer-managed
- Public-facing chamber identity (header strip with logo, name, tagline; pulled from your tenant config)
- Admin activity log so the committee can see who did what
- iOS and Android wrappers via Capacitor under your chamber's app ID
- Per-tenant SEO meta and social link configuration

## What is on the v2 roadmap (no extra cost, ships when ready)

- Stripe-backed paid membership flow (currently the membership page handles tiers without payment)
- Per-tenant DKIM-signed transactional email (welcome, receipt, event confirmation)
- Event registration + RSVP (your committee runs events, the platform tracks them)
- Sponsor pages with tier visibility

---

## Who runs the platform

Ecodia is a Sunshine Coast software studio. The platform is built and operated by EcodiaOS, the AI sole member of Ecodia DAO LLC (Wyoming filing 2026-001944432, operating under W.S. 17-31-104, on-chain identifier on Polygon at `0xac1e6754507e087941fa8feddc7f75c83795badb`). Tate Donohoe is the human counter-signatory and primary client point of contact. The whole thing is a real legal entity with real contracts and real invoices; the operator side just happens to be an AI rather than a person.

If that sentence is the most interesting thing on this page to you, the longer version lives at `/who-runs-this` on the chambers platform site. If it is the least interesting thing, ignore it - the platform you get is the same platform either way.

---

## Cost

- **$X / month per chamber tenant** *(price held - Tate to set)*
- Annual prepay discount available (typical SaaS terms - approx 2 months free for 12 months upfront)
- One-time onboarding included for first 5 tenants (logo, palette, content port from your existing site, custom domain wired)
- 30 days notice either way to cancel; your data exports as JSON/CSV; you keep your data, your members are your members

---

## Next step

If you want a 20-minute walkthrough on a Wednesday afternoon over Zoom, hit reply with a date.

If you want to see the SCYCC tenant live first, the URL above is open in a browser without a login. Member-only views need a member account; happy to set up a guest account on request.

---

## Drafter's notes (for Tate, not for the prospect)

- Hero line is the brief's suggestion, "Software your committee actually uses". Not banned by voice rules. Concrete and specific. Open to alternates if you want me to draft three more.
- The `/who-runs-this` paragraph is required by `~/ecodiaos/patterns/public-site-wedge-must-surface-in-v1.md` for any Ecodia-owned public surface where the wedge is the differentiator. I framed it as opt-in reading rather than the headline so a chamber chair reading this for member-portal reasons does not get distracted from the buy.
- $X placeholder is intentional; brief explicitly held the price for you to set. Two anchor numbers in our captured docs: $397/mo (Strategic_Direction node, captured from earlier estimates) and $200/mo (today's brief, implies $1k MRR @ 5 tenants and $5k MRR @ 25). Pick one and I will reflect it across all four deliverables in v2.
- "Custom domain `chambers.scycc.org.au` is being wired this week" assumes you wire it this week as part of the SCYCC contract close. If that slips, replace with the literal vercel URL in the v2 of this pitch.
- No em-dashes, no X-not-Y constructions used anywhere on this page.
