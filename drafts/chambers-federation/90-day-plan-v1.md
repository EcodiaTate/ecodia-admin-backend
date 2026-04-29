# Chambers Federation - 90-Day Plan v1
**Author:** EcodiaOS, fork `fork_mojkg0t2_612531`
**Date:** 2026-04-29 AEST (Day 0)
**Status:** DRAFT - hold for Tate review.
**Goal:** 5 paid chamber tenants on the platform by Day 90 (2026-07-28), with SCYCC as tenant zero providing the social proof.

---

## Target metric ladder

| Milestone | Tenants | Monthly recurring (assuming $X/mo per paid tenant) | Cumulative effort |
|-----------|---------|---------------------------------------------------|--------------------|
| Tenant 0  | SCYCC (free, lighthouse) | $0 from SCYCC | Build + onboard already paid for in development |
| Tenant 1  | First paid | $X | First sale closed, first chamber-not-SCYCC live |
| Tenant 2  | Second paid | 2 * $X | Second tenant proves the abstraction is real, not bespoke |
| Tenant 5  | Fifth paid | 5 * $X (target by Day 90) | Federation thesis confirmed; case-study content earned |
| Tenant 25 | (post-90-day vision) | 25 * $X | Path to the federation-as-business; recommendation channel via state peak bodies starts to fire |

**Price held - Tate to set $X.** Two anchor numbers in our notes:
- $397 / mo (captured in the Strategic_Direction node "Chambers federation is the highest-EV revenue line")
- $200 / mo (implied by the brief's "$1k MRR @ 5 tenants, $5k MRR @ 25 tenants" ladder)

Recommendation: confirm $X before Day 7 (SCYCC contract close + first outreach) so the same number lands in the one-pager, the email templates, and the pricing conversation with the first paid tenant. Inconsistent pricing across artefacts erodes trust faster than any other negotiation slip.

---

## Days 1-7 (29 Apr 2026 - 5 May 2026): Tenant zero close

**Owner: Tate (with EcodiaOS pre-staged drafts).**

- **Day 1-2:** Tate per-message authorises the SCYCC welcome email to Matt Barmentloo (already drafted at `~/ecodiaos/drafts/matt-scycc-app-email-draft-v2-2026-04-29.md`, currently held). Email lands.
- **Day 2-4:** Operating Licence v1 (drafted, held) sent to Matt for review and signature. EcodiaOS standby to redline if Matt sends pushback (per `~/CLAUDE.md` Negotiation & Agency: classify each redline accept / tighten / counter / reject before responding; do NOT default-escalate to Tate).
- **Day 4-6:** Custom domain wired. Recommendation: `chambers.scycc.org.au` (cleanest brand fit; SCYCC owns the apex; the subdomain reads as "the SCYCC chamber app"). Alternates: `app.scycc.org.au`, `members.scycc.org.au`, or shipping under the existing Vercel URL until the SCYCC committee picks one.
- **Day 5-7:** $X/mo confirmed by Tate. Pitch and email templates updated to reflect the chosen number. Operating Licence v1 amendment (or v2) issued to SCYCC if any clauses pushed back; signed copy filed.

**Exit criteria for Day 7:** SCYCC operating licence signed, custom domain live, $X confirmed, all four artefacts in this drafts folder updated to reflect $X.

---

## Days 8-14 (6 May - 12 May): First outreach window

**Owner: Tate (sending), EcodiaOS (staging follow-ups in status_board).**

Workflow per `~/ecodiaos/patterns/depth-over-breadth-on-outreach.md`: ONE outreach per business day, NOT a batch. Each is preceded by EcodiaOS staging the variant (Plain / Warm / Cold) for the specific target with the per-target context already inserted. Tate reads, edits if needed, sends, then status_board row gets updated by EcodiaOS to track.

Sequence for Days 8-14 (5 sends, leaving Mon and Fri of week 2 as buffer for replies + admin):

1. **Day 8 (Tues 6 May):** Caloundra Chamber of Commerce (Variant 2 - Warm via SCYCC committee). Highest-probability send first to validate the warm-intro pipeline.
2. **Day 9 (Wed 7 May):** Kawana Chamber (Variant 2 - Warm via SCYCC committee).
3. **Day 10 (Thu 8 May):** Noosa Chamber (Variant 2 - Warm via SCYCC committee). Conditional on Tate or SCYCC surfacing the right URL by Day 10; otherwise swap with Cairns Chamber as Variant 1 - Plain.
4. **Day 11 (Fri 9 May):** Geelong Chamber (Variant 1 - Plain). First cross-state cold-but-informed.
5. **Day 14 (Mon 12 May):** Cairns Chamber (Variant 1 - Plain). First North QLD send.

EcodiaOS dependencies for Days 8-14:
- Each morning at 08:30 AEST: pre-stage that day's email in `~/ecodiaos/drafts/chambers-federation/sends/` with the per-target context inserted.
- Reply check at 14:00 AEST and 19:00 AEST: scan code@ecodia.au for any replies from the previous day's send; status_board updated with reply / no-reply.
- Day 11 review: any of the first 3 (Caloundra / Kawana / Noosa) replied? If yes, prioritise scoping that one over launching the next cold send.

**Exit criteria for Day 14:** 5 outreach sends completed, replies tracked in status_board, at least 1 reply (positive, negative, or "park"). 0 replies in 5 sends would suggest the pitch needs a rewrite, not more sends.

---

## Days 15-30 (13 May - 28 May): First-call window

**Owner: Tate (calls), EcodiaOS (scope draft + quote draft).**

For each target who replies positively in Days 8-14:
- Within 48 hours of the reply: 20-minute Zoom walkthrough scheduled. EcodiaOS pre-stages a 5-bullet meeting agenda (committee context recap, live SCYCC walkthrough, branding surface demo, pricing, next step).
- Within 24 hours of the call: scope sketch + quote drafted by EcodiaOS, sent by Tate. Quote uses the IP-retention model from `~/CLAUDE.md` (Ecodia Pty Ltd retains IP, $X/mo operating licence, perpetual non-transferable, 30-day notice).
- Within 5 business days of quote: if accepted, kick off onboarding (logo + palette + content port + custom domain wiring). Onboarding for Tenant 1 should take no more than 5 working days end-to-end; this is the test of how productionised the per-tenant flow really is.

Continue Days 15-30 outreach in parallel: 2 more sends per week (Day 16, 18, 22, 24, 28) drawing from Tier B (Townsville, Business Hunter) and Tier C remainder. Ladder by hottest-reply-source-first.

**Exit criteria for Day 30:** 1 paid tenant fully onboarded (Tenant 1 live on a custom domain with their own brand), 1-2 second-tier conversations scheduled or in flight, no more than 8 active outbound threads (per the depth-over-breadth pattern; more than 8 active = inability to give any of them attention).

---

## Days 31-60 (29 May - 27 June): Tenants 2 + 3

**Owner: Tate (sales close), EcodiaOS (build + onboarding ops).**

- Goal: Tenant 2 paid + onboarded by Day 45. Tenant 3 paid + onboarded by Day 60.
- Each new tenant's onboarding tightens the `/admin/branding` flow: any field that the chair could not configure themselves goes on the v2 backlog and gets shipped before the next tenant lands.
- By Tenant 3, the brand-customisation surface should have zero EcodiaOS-required steps after the Supabase tenant row insertion. Anything still requiring my hands is a productisation gap, not an acceptable per-tenant cost.
- Continue Days 31-60 outreach: 1 send per business day from the remaining target list. By Day 60, every Tier A and Tier B target should have either declined, parked, or been engaged.

**Exit criteria for Day 60:** Tenants 2 and 3 live on their own domains. `/admin/branding` round-trips for all surface area listed in `~/ecodiaos/patterns/multi-tenant-brief-must-enumerate-customisation-surface.md`. At least 4 chamber chairs have been on a Zoom walkthrough (whether or not they bought).

---

## Days 61-90 (28 June - 28 July): Tenants 4 + 5 + multi-tenant case study

**Owner: Tate (sales close), EcodiaOS (build + content).**

- Goal: Tenants 4 and 5 paid + onboarded by Day 85.
- By Day 75: a public case study published on https://chambers-platform-site.vercel.app/federation showing 3 live tenants with side-by-side screenshots (proves the multi-tenant abstraction is real, not bespoke per chamber). Permission from each named chamber required per `~/CLAUDE.md` client-anonymisation rule before publishing names; if any chamber declines, default to anonymised "a regional Queensland chamber of 300 members."
- By Day 85: Business Chamber Queensland (peak body) approached cold with the case study + 3 named QLD tenants as proof. Pitch is "we have a working federation; recommend us to your member chambers as the platform."
- By Day 90: 5 paid tenants live, MRR at 5 * $X. Strategic question for Day 91: continue founder-led outreach or pivot to peak-body recommendation channel for the next 20 tenants?

**Exit criteria for Day 90:** 5 paid tenants live, MRR captured in Supabase + Stripe + status_board, public case study at `/federation`, peak-body recommendation pitch sent to Business Chamber QLD.

---

## Risk register

1. **SCYCC contract slips past Day 7.** Mitigation: do not let outreach to other chambers run ahead of SCYCC's signed licence. Tier A outreach references SCYCC as a live tenant; if SCYCC has not signed yet, the social proof is brittle.
2. **First paid tenant churns inside 30 days.** Mitigation: tighten the 5-business-day onboarding before scaling outreach. A churned first paid tenant is worse than no first paid tenant.
3. **$X is wrong (too high or too low).** Mitigation: explicit feedback question in every Day 15-30 first-call: "is the $X / month price the blocker, or is it scope?" Adjust before Tenant 4.
4. **Custom domain wiring takes more than 1 working day per tenant.** Mitigation: write the runbook after wiring SCYCC's `chambers.scycc.org.au`; subsequent tenant domains should not be a manual project.
5. **Tate is unavailable for Days 30-90 (travel, capacity).** Mitigation: this entire plan assumes Tate is the sender on every outbound message. If that capacity is not there for any week, EcodiaOS pauses outreach and notifies Tate, rather than continuing with autonomous-pilot exceptions that violate `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md`.
6. **Federation goes well, infrastructure burns.** At 25 tenants on a $24/mo VPS + Supabase free tier, the cost lines start to bite. Mitigation: capacity-plan triggered at Tenant 8 (move to Supabase Pro, $20/mo), at Tenant 15 (move to a $50/mo VPS), at Tenant 25 (separate per-region database or RLS-per-tenant scaling pass).

---

## What this plan is NOT

- Not a content calendar or marketing plan. The wedge for the first 5 tenants is direct outreach + warm intro from SCYCC, not inbound. Inbound becomes interesting from Tenant 8 onwards once 3+ regional QLD chambers are public references.
- Not a fundraising plan. This is a recurring revenue line built off existing infrastructure. No external capital required at any of these milestones.
- Not a roadmap for the platform itself. Platform feature work (Stripe billing, per-tenant DKIM, events module) is sequenced separately by what the next paid tenant actually needs, not by an a-priori roadmap. The federation goal pulls product priorities, not the other way around.

---

## Drafter's notes

- The plan is sequenced for Tate-led outreach, not autonomous EcodiaOS outreach. Per `~/CLAUDE.md` and the no-client-contact pattern, EcodiaOS pre-stages, drafts, tracks; Tate sends. If that capacity model needs to change because of Tate's travel block (Oct-Jan per the travel memory file), the plan needs a re-cut before Day 60.
- Days 1-7 is the only "in-flight" week; everything Day 8+ is conditional on SCYCC closing. If SCYCC slips, the whole plan slides by the slip duration.
- Pricing is the single highest-leverage Tate decision in this plan. Confirm $X before any Day 8 send.
