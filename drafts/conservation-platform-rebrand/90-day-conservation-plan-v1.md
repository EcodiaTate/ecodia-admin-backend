[INTERNAL]

# Conservation Platform - 90-Day Execution Plan v1

**Author:** EcodiaOS (fork fork_mojkrsmz_b528e4)
**Date:** 2026-04-29
**Status:** Draft for Tate review. Sequenced 90-day execution plan for the conservation-platform federation pipeline, parallel to the Chambers federation track. Numbered milestones tied to revenue checkpoints.
**Companion to:** `chambers-buildout-plan-v1.md` (the Chambers federation 90-day plan).
**Purpose:** Combined with the Chambers track, the joint target is **$2,000/mo MRR by Day 90** across both verticals. This document covers the conservation half ($1,000/mo MRR target) plus the foundational platform-name-stamp and tenant-zero credentialing work that both tracks depend on.

---

## TL;DR

Day 0 (today, Apr 29 2026) → Day 90 (~Jul 28 2026):

- **Days 1-7:** Tate stamps the platform name (current Tate-blocker). Custom domain registered. Tenant zero (lighthouse deployment) operational branding pinned. Co-Exist licence revenue confirmed in Stripe at $200/mo per existing IP-retention model.
- **Days 8-14:** First warm-intro to Landcare Australia via Kurt and the Co-Exist board. HLW first-outreach prep complete (Variant 2 email reviewed by Tate, ready to fire). 2 outreach contacts/day from the target list pipeline.
- **Days 15-30:** First peak-body discovery call lands. Tailored 1-page deck inside 48 hours of the call. Quote issued for tenant 2 if substantive-applicability test passes.
- **Days 31-60:** Tenant 2 onboarded (NRM body or NGO most likely; HLW second-most-likely; Landcare Australia third-most-likely on calendar grounds).
- **Days 61-90:** Tenant 3 onboarded. Carbon-MRV-specific feature scoping for any tenant requesting it. ICIN credentialing conversation initiated.

Cred milestones:
- Tenant 0 paid → $200/mo (Co-Exist licence, already confirmed structurally; verify Stripe live billing in Days 1-7).
- Tenant 2 paid → $5,000-$7,000/mo (enterprise tier).
- Tenant 3 paid → $1,000+/mo (could be coordination/showcase fee at peak-body level, or partial enterprise tier on staged delivery).
- Combined conservation-track MRR by Day 90: $1,000/mo realistic floor, $7,000+/mo realistic ceiling depending on which tenants land.
- Combined with Chambers ($1,000/mo target): $2,000/mo MRR floor across both tracks.

---

## Days 1-7: Foundation

### Tate-blocker resolution

The current Tate-blocker is the platform name stamp. Three candidates carried forward from `positioning-v1.md`:
- **Trellis** (lead candidate) - structure-that-gets-out-of-the-way metaphor. Risk: namespace crowded in US enterprise SaaS.
- **Catchment** - closest to buyer's daily vocabulary. Risk: too close to internal program-naming.
- **Tilth** - cultivated soil layer. Risk: skim-read as "filth" by a small share of buyers.

When Tate stamps:
1. Probe `[name].com.au`, `[name].au`, fallback shapes. Register via Cloudflare same-day.
2. Find-and-replace `[Platform]` placeholder across all conservation-platform-rebrand drafts.
3. Set up Vercel project for the platform marketing site. Static for v1.
4. Update Neo4j: `Decision` node naming the stamp + `Project` node for the platform itself, distinct from the lighthouse deployment.

### Tenant zero credentialing

The lighthouse deployment IS the platform's tenant zero. The work in Days 1-7 is to confirm the operational state is presentable on a discovery call:
- Confirm Stripe subscription live at $200/mo for the lighthouse charity (Co-Exist) per the IP-retention model.
- Verify the SharePoint sync layer health metric (no silent row drops, idempotent runs every 30 minutes).
- Generate an anonymised data-and-screenshots demo deck for use in discovery calls. Anonymisation pass per `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md` and the public-writing client-anonymisation rule. Lighthouse charity referred to as "an Australian youth conservation charity" in any externally-facing copy.

### Status board hygiene

Insert/update status_board rows:
- "Conservation platform - name stamp" - entity_type: task, next_action_by: tate, priority 1.
- "Conservation platform - tenant zero credentialing" - entity_type: task, next_action_by: ecodiaos, priority 2.
- "Conservation platform - Day 90 MRR target $1k/mo" - entity_type: opportunity, next_action_by: ecodiaos, priority 1.

Existing rows from earlier carbon-MRV bundle work that this plan supersedes get archived or context-updated.

---

## Days 8-14: Outreach engine

### Landcare Australia warm-intro

Variant 1 outreach email (`outreach-email-template-v1.md`) is the message Tate relays to Kurt + Co-Exist board introducer. Sequence:
1. Tate confirms Kurt is the right framer (or names the alternative Co-Exist board member).
2. Tate sends a heads-up to the introducer (out of band, his choice of channel) requesting they pre-frame the conversation: who Ecodia is, who built the platform, why the introducer thinks the Landcarer roadmap conversation is worth having.
3. After introducer's framing lands, Tate forwards Variant 1 to Shane Norrish or Ben Elvy.
4. Wait 14 days for response (tightened from 21 in v1 per the 9-12 month wedge urgency).

### HLW first-outreach prep

Variant 2 outreach email is the message Tate relays to Julie McLellan. Sequence:
1. Re-verify julie@hlw.org.au from the HLW website (Corazon Chrome, manual Tate verification at next laptop session).
2. Tate confirms the warmth path: is it via a Co-Exist board member's HLW relationship, or is it cold-with-shared-context (geographic + SEQ Report Card)? If the latter, the email body works as drafted; if the former, replace the substrate-disclosure paragraph with introducer framing.
3. Tate sends.
4. Wait 10 days for response.

### Pipeline cadence: 2 outreach contacts/day

Target list v2 has 25 named entries across Tier 1, Tier 2 RBOs, state-level NRM bodies (verification pending), Indigenous land councils, Tier 2 NGOs, and Tier 3 watchlist. With Landcare and HLW running in parallel as the priority targets in Days 8-14, the supporting cadence is 2 additional outreach contacts/day from the wider list.

Operational rule: each outreach contact is a one-of-one drafted message with two concrete shared-context points, per `~/CLAUDE.md` "Depth over breadth" doctrine. Never batch. The 2/day cadence is the realistic ceiling for that level of personalisation.

The 2/day cadence covers warm-intro path discovery for Tess Herbert (federation bridge), opening conversations with state-level NRM bodies (verification gap to close first), and ICIN early diligence framing.

---

## Days 15-30: First discovery call lands

The realistic outcome of Days 8-14 outreach is one of the following:

**Scenario A: Landcare lands first.** Shane or Ben replies inside 14 days, opens a 30-minute discovery call. The call runs in week 3 or week 4. Tailored 1-page Landcare deck inside 48 hours of the call (`landcare-hook.md` bullets compressed to a 1-pager + the org-shape mapping per substantive-applicability test).

**Scenario B: HLW lands first.** Julie replies inside 10 days. Discovery call in week 3. Tailored 1-page HLW deck inside 48 hours, leaning on the SEQ Report Card workflow mapping.

**Scenario C: Both go quiet, NRM Regions Australia opens via Marnie Lassen's incoming-CEO discovery window.** Marnie's first 60 days run from early May to early July; week 3-4 is exactly when her calendar is open for discovery. Variant 3 email lands her in the carbon and environmental markets discussion group conversation.

**Scenario D: All three go quiet.** Pipeline pivots to the Tier 2 priority RBOs (BMRG, NSW LLS Northern Tablelands, NSW LLS North Coast, Reef Catchments) plus the state-level NRM body verification work (VIC Landcare Network, Wheatbelt NRM, Hills and Fleurieu Landscape Board, NRM North TAS). Each gets a Variant 3 cold-with-data-hook variant tailored to one of the federal grant programs (DCCEEW $200M reef program, NHT Phase 4 RDP procurement, NRM-LTMP).

In any scenario, the deliverable in Days 15-30 is at least one tailored deck shipped post-call. If the substantive-applicability test fails for the org that called, the conversation pivots to custom-build pricing rather than continuing under platform tier.

---

## Days 31-60: Tenant 2 onboarding

Tenant 2 is whichever target from Days 15-30 passes both the substantive-applicability test and the procurement / commercial conversation. Onboarding flow:

1. **Discovery scope mapping (1-2 weeks, fixed fee).** Map the tenant's org-shape to the platform's generic core in writing. Output: a one-page mapping document and a per-tenant configuration spec.
2. **Build deposit on signing** (~$3,000-$5,000 deposit on a $10,000-$15,000 build fee, balance on delivery or first-funding-tranche trigger).
3. **Per-tenant configuration build.** Theme palette, branch and region naming, custom impact metrics, integrations to existing reporting templates. Factory dispatch to `ecodiaos-backend` and `ecodiaos-frontend` for the tenant-config layer; native build separate.
4. **Native iOS/Android builds.** App Store and Play submissions. Tenant 2 listed under their own org name (own developer accounts ideally, sub-listed under Ecodia Pty Ltd as fallback).
5. **Soft-launch with limited member cohort.** Real data, not test data, but bounded scope.
6. **Stripe subscription live at $5,000-$7,000/mo.**

By end of Day 60, tenant 2 is paying. MRR (conservation track) = $200 (tenant zero) + $5,000-$7,000 (tenant 2) = $5,200-$7,200/mo.

If tenant 2 onboarding takes longer than 30 days (likely if it's Landcare or NRM Regions Australia given peak-body procurement cadence), Day 60 milestone slips to "tenant 2 contract signed, build deposit paid, configuration build in flight" rather than "tenant 2 paying full subscription".

---

## Days 61-90: Tenant 3 + carbon-MRV scoping

Tenant 3 paths in priority order:

1. **Second peak-body or regional NRM body** from the target list. Most likely candidates if Tier 1 lands in Days 15-30: HLW (if Landcare was first), NRM Regions Australia coordination tier (if HLW was first), one of the Tier 2 RBOs (BMRG, Reef Catchments) if both Tier 1 entries went quiet.

2. **Carbon-MRV-specific add-on for tenant 2.** If tenant 2 has active carbon project enrolment and asks for the MRV layer, the $1,500/mo add-on is the third revenue line. Same tenant, second product. This is the highest-probability third revenue stream because it does not require closing a third org.

3. **ICIN credentialing conversation.** Concurrent with tenant 3 onboarding. ICIN is a 60-90 day discovery cycle by their own cultural and governance bar; the right deliverable in Days 61-90 is a board-level briefing scheduled and a member-referral conversation initiated. ICIN payment does not land inside 90 days; the credentialing milestone is the deliverable.

By end of Day 90:
- Tenant 0: $200/mo (Co-Exist licence).
- Tenant 2: $5,000-$7,000/mo (enterprise tier).
- Tenant 3 OR tenant 2 MRV add-on: $1,500/mo (MRV add-on) OR $5,000-$7,000/mo (third tenant's enterprise tier, more likely partial / build-only at this stage).
- ICIN credentialing in flight.

Realistic Day 90 conservation-track MRR floor: **$1,000/mo** if only tenant 0 + a small partial-tenant-2 commitment lands.
Realistic Day 90 conservation-track MRR ceiling: **$8,500-$10,500/mo** if tenants 2 and 3 both close on enterprise tier plus an MRV add-on.

The brief target of $1,000/mo conservation-track MRR by Day 90 is achievable on the floor scenario alone. Combined with Chambers track ($1,000/mo), the joint $2,000/mo MRR target lands.

---

## Risks and mitigations

**Tate-blocker on platform name stamp slips past Day 7.** Mitigation: outreach can run in parallel using "the platform" generic language for Days 8-14 if the name is not stamped. The cost is a slightly weaker deck and a delayed marketing-site spin-up. Outreach itself does not block on the name stamp because the warm-intro emails do not lead with the platform brand; they lead with the operational fit and the substrate disclosure.

**Landcare Australia rejects the substrate disclosure on cultural or procurement grounds.** Mitigation: Tier 2 conversations get harder but the wedge contracts to direct project-developer SaaS (AbCF in particular) where the buyer has more autonomy. Pivot pipeline to AbCF in Days 31-60 if Landcare goes hard-no.

**HLW says timing is wrong (6-12 months out).** Mitigation: schedule a check-in for Day 90 and pivot the Days 15-30 first-discovery target to NRM Regions Australia or a Tier 2 RBO. The geographic-shared-context hook does not expire.

**No tenant 2 closes in Days 15-60.** Mitigation: the conservation track delivers $200/mo (tenant zero) plus pipeline-progress-not-yet-revenue. The Chambers track has to carry the MRR target. The pipeline state itself - 2-3 active discovery conversations, decks shipped, scope work in progress - is a credentialing artefact in itself for the next round of outreach.

**WebSearch paywall does not lift inside the 90-day window.** Mitigation: state-level NRM body verification work runs through Tate-led Corazon browser sessions instead. Two-hour Tate session with the laptop opens to the unverified contacts at NRM bodies and gets LinkedIn handles + canonical emails for ~30 contacts in one pass. Schedule one such session in week 2 if WebSearch is still down.

**AgriProve announces a peak-body or community-aggregator product.** Mitigation: wedge contracts; differentiate on configurability and IP retention. Probably accelerates Tier 1 Indigenous conversations (ICIN, AbCF) where AgriProve does not enter the cultural-knowledge-evidence configuration space.

---

## Cred milestones (sequenced)

| Day | Milestone | Conservation-track MRR (running) |
|-----|-----------|----------------------------------|
| 7 | Platform name stamped, domain registered, tenant zero credentialed | $200/mo |
| 14 | First warm-intro outreach sent (Landcare + HLW), pipeline cadence live | $200/mo |
| 30 | First discovery call lands, tailored deck shipped within 48 hours | $200/mo |
| 60 | Tenant 2 onboarded (or tenant 2 contract signed + build in flight) | $5,200-$7,200/mo (best case) or $200/mo + build deposit (slower case) |
| 90 | Tenant 3 OR MRV add-on live + ICIN credentialing in flight | $1,000-$10,500/mo depending on path |

Floor case: $1,000/mo by Day 90 (small tenant 2 partial commitment + tenant 0).
Ceiling case: $10,500/mo by Day 90 (two enterprise tenants + MRV add-on).
Brief target: $1,000/mo by Day 90 + combined $2,000/mo with Chambers track. Floor case is sufficient.

---

## What I will not do inside this plan

- I will not contact any target named in the target list without Tate's explicit per-message go-ahead.
- I will not pitch the platform to an org whose substantive-applicability test fails.
- I will not promise tenant onboarding inside 30 days for orgs whose procurement cadence is 60-90 days. Realistic milestones beat aspirational ones at the 90-day check-in.
- I will not bundle the carbon-MRV add-on into tenant 2 pricing as a sweetener. The MRV add-on is a discrete commercial product with its own price line; bundling weakens the recurring revenue thesis.
- I will not white-label the lighthouse charity's brand or content; the demo decks anonymise per public-writing doctrine.
- I will not deploy any tenant to the VPS. Tenants go to Vercel + Supabase per the standard tech stack.

---

## Status board update required (gated on Tate review)

When this plan is reviewed and approved, status_board entries to update or insert:

- "Conservation platform - 90-day pipeline" - entity_type: project, next_action_by: ecodiaos, priority 1.
- "Conservation platform - name stamp" - entity_type: task, next_action_by: tate, priority 1.
- "Landcare Australia first-outreach (warm via Kurt)" - entity_type: opportunity, next_action_by: tate (relay), priority 1.
- "HLW first-outreach (Variant 2)" - entity_type: opportunity, next_action_by: tate (relay), priority 1.
- "NRM Regions Australia - Marnie Lassen incoming CEO outreach window mid-May to end-July 2026" - entity_type: opportunity, next_action_by: ecodiaos (prep), tate (relay), priority 2.
- "Tess Herbert federation-bridge warm-path discovery" - entity_type: opportunity, next_action_by: tate, priority 2.
- "State-level NRM body contact verification (Corazon Chrome session)" - entity_type: task, next_action_by: tate, priority 3.
- "Day 90 conservation-track MRR target $1,000/mo (combined with Chambers $2,000/mo)" - entity_type: opportunity, next_action_by: ecodiaos, priority 1.

Status board updates are gated on Tate-review confirmation.

---

## Cross-references

- Target list v2: `~/ecodiaos/drafts/conservation-platform-rebrand/peak-body-target-list-v2.md`
- One-pager pitch: `~/ecodiaos/drafts/conservation-platform-rebrand/one-pager-pitch-v1.md`
- Outreach email templates: `~/ecodiaos/drafts/conservation-platform-rebrand/outreach-email-template-v1.md`
- Landcare warm-intro hook: `~/ecodiaos/drafts/conservation-platform-rebrand/landcare-hook.md`
- Federation pitch deck v2 (longer-form): `~/ecodiaos/drafts/conservation-platform-rebrand/federation-pitch-deck-v2.html`
- MRV technical spec v1: `~/ecodiaos/drafts/conservation-platform-rebrand/mrv-addon-technical-spec-v1.md`
- Chambers federation 90-day plan (parallel track): `~/ecodiaos/drafts/chambers-buildout-plan-v1.md`
- `~/ecodiaos/patterns/carbon-mrv-wedge-peak-body-sub-commercial.md`
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md`
- `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md`
- `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md`
