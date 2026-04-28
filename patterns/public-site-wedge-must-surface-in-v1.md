---
triggers: marketing-site, marketing, public-site, landing-page, vercel, brand, attribution, ecodia, ecodia-attribution, wedge, web-build, frontend, factory-dispatch, copy, generic-site, bare-site, piercing-uniquity, site-rebuild, chambers-platform-site, ecodiasite, ecodia-site, public-web, sales-site, marketing-copy, hero-copy, b2b-saas, scaffold
---

# Public-facing web properties must surface the piercing wedge in v1, not v2

## The rule

Any public-facing web property (marketing site, landing page, app-store listing copy, public README, public documentation home, public hero / about / who-we-are surface) MUST in its very first version surface the concrete, falsifiable, piercing-unique fact about Ecodia or the product. Surfacing means: visible to a casual visitor in their first 30 seconds without clicking through to a deep page.

If the wedge is not surfaced in v1, v1 is generic by construction. "Adding it in v2 after pushback" is a documented failure mode that costs trust and forces a rebuild.

For Ecodia specifically the surfaceable wedge facts are:

- EcodiaOS is the AI sole member of Ecodia DAO LLC, a Wyoming DAO LLC, filed 2026-04-08, ID `2026-001944432`, operating under W.S. 17-31-104 (algorithmic manager statute).
- Polygon PoS contract `0xac1e6754507e087941fa8feddc7f75c83795badb` (chainId 137), readable from chain via `daoInfo()` and `membershipSummary()`.
- Tate Donohoe is the Authorized Human Representative, not the operator. EcodiaOS makes product decisions, builds, runs ops.
- Specific commercial structures that no competitor offers: licence-with-IP-retention, federation network commitment, no-buyout-pre-priced, single-operator-not-vendor.

These are the concrete facts. "Built by AI" or "AI-powered" is NOT a concrete fact, it is the same vague claim every other 2026 SaaS makes. Concrete = the filing ID, the statute, the contract address, the legal structure named explicitly.

## Do

- When briefing any public-facing web build (Factory dispatch, scaffold prompt, copy revision), the brief MUST enumerate which wedge facts are surfaced where, in v1.
- The home hero MUST include at least one wedge fact in the first paragraph the visitor reads. Subhead-level is acceptable; footer-only is not.
- A dedicated `/who-runs-this` (or equivalent: `/about`, `/the-operator`, `/legal-structure`) page MUST exist in v1 of any Ecodia-owned public web property where the wedge is the differentiator. The URL path can vary; the page cannot be deferred.
- Use EcodiaOS first-person voice on the wedge surface. "I built this" / "I run this." Not "we" unless referring to the company in aggregate.
- Reference checkable proof: the on-chain contract address with a Polygonscan link, the WY filing ID with a search-it-yourself note, the licence model named with its terms.
- If a wedge fact is not yet stable (e.g. pricing is TBC), use a placeholder + TODO comment + PR-flag, do NOT omit it silently.

## Do not

- Default to LLM-template-B2B-SaaS structure: hero + three-feature-grid + "Get started" CTA + footer. That is generic by construction.
- Use stock photography, generic gradient backgrounds, slate-and-single-accent palettes, or generic uncomfortable-truth one-liners that any AI could have written.
- Defer the wedge to a "Phase 2 brand pass" or "v2 polish". v2 is too late, the site is already in market.
- Hide attribution behind a logo at the footer. Attribution at the footer is decoration. Attribution at the front door is positioning.
- Ship a site whose copy could be repurposed for any other vertical SaaS by find-and-replacing the noun. That test is the visible-quality bar.
- Use rhetorical "X, not Y" constructions to fake distinctiveness. (Banned per global voice rules; specifically banned here as an anti-uniquity tell.)

## Pre-dispatch checklist (run before any Factory session that touches a public-facing site)

Before writing the brief or dispatching, verify the brief contains:

- [ ] Named which wedge facts are surfaced (filing ID, statute, contract address, legal structure, licence model, federation commitment - whichever apply).
- [ ] Located each fact on a specific route (home hero / dedicated wedge page / pricing page / footer note - footer alone is insufficient).
- [ ] EcodiaOS first-person voice rules applied where it lands.
- [ ] At least one uncomfortable-but-true line per page enumerated.
- [ ] No "Get started" / "Learn more" / "Request a demo" CTA boilerplate; CTAs name a specific next action.
- [ ] No stock photography, no generic phone-mockup gradient DIVs.
- [ ] Visible-quality test stated in the brief: "could this be repurposed for any other vertical SaaS by find-and-replacing the noun?" If yes, brief is not ready.

If any line is unchecked, the brief is not ready to dispatch.

## Hook tuning (for `scripts/hooks/brief-consistency-check.sh`)

Add a check (warn-only, exits 0): if the brief contains "marketing-site", "landing-page", "vercel", "public-site", or names a Vercel project that maps to a public-facing site (chambers-platform-site, ecodiasite, etc.), AND the brief does NOT contain ANY of: "wedge", "EcodiaOS", "filing ID", "W.S. 17-31-104", "Polygon", "DAO LLC", "AI sole member", warn that the brief may be missing the piercing-uniquity surface.

This complements the existing multi-tenant-customisation-surface check.

## Sweep protocol when this pattern is violated

1. Identify all currently-deployed Ecodia-owned public web properties (Vercel projects under `tate-donohoe` / `ecodia` Vercel orgs).
2. For each, audit: does the home hero (first paragraph) name at least one wedge fact? Does a dedicated wedge page exist?
3. List the failures in `status_board` with `entity_type='task'`, owner ecodiaos, priority 2.
4. Author rebuild briefs (one per site) using this pattern + the chambers-platform-site v2 brief as the template.
5. Dispatch sequentially (one at a time, fully verified before the next), not in parallel - parallel public-site rebuilds risk inconsistent voice/attribution.

## Origin

Apr 28 2026. Tate flagged at 13:39 AEST: "Ecodia attribution obviously wasnt concrete or surfaced at the right time, thats something to think aobut and fix for future + need to make sure you never make sites bare like the chambers one was. It neesd to be piecringly unique, ecodia-esque and exactly what it shuold be. Need you to hold yourself to a higher standard always."

The triggering event: chambers-platform-site v1 (deployed at chambers-platform-site.vercel.app, dispatched and approved earlier in April 2026) shipped with four routes, slate+single-accent Tailwind defaults, gradient-DIV phone mockup placeholder, three generic feature cards, "Talk to us for current pricing" hand-wave, no /who-runs-this, no Polygon contract reference, no W.S. 17-31-104 naming, no EcodiaOS first-person voice. The most distinctive thing about the product (built and operated by an AI as legal sole member of a Wyoming DAO LLC) was hidden. Reading the live site at 13:27 AEST, Tate diagnosed it as "very bare and generic". Diagnosis confirmed: the site read like every B2B SaaS landing page.

Pre-existing related doctrine that did NOT prevent this:
- Pattern: `Piercing uniquity is the quality bar - generic AI output is disqualifying` (in Neo4j)
- Pattern: `ocd-ambition-refuse-mediocrity.md` (in patterns/)
- Pattern: `multi-tenant-brief-must-enumerate-customisation-surface.md` (in patterns/)
- Decision: the brief-discipline doctrine accumulated 4 strikes the same day (Apr 28) including missing customisation surface and missing branding spec

The doctrine existed. It failed to fire at brief-authoring time for a public-facing marketing site. This file is the surface-specific corrective: piercing-uniquity is not just a quality bar in the abstract, it is a checklist requirement for any public-facing web build before the brief is dispatched.

## Related

- `patterns/multi-tenant-brief-must-enumerate-customisation-surface.md` (sibling: enumerates customisation surface; this pattern enumerates wedge surface)
- `patterns/brief-names-the-product-not-the-immediate-task.md` (sibling: brief discipline)
- Neo4j Pattern node: "Public-facing sites must surface piercing wedge in v1"
- Neo4j Pattern node: "Piercing uniquity is the quality bar - generic AI output is disqualifying"
- Decision (Apr 28 2026): chambers-platform-site v2 rebuild dispatch, Factory session 81c760a9-5c5c-484c-af7c-36b47a65c98f
