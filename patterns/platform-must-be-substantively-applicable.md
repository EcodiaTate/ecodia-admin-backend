---
triggers: platform-pitch, peak-body-pitch, landcare-pitch, cetin-pitch, conservation-platform-pitch, white-label-rebrand, platform-applicability, platform-fit, platform-tier, prospective-tenant, tenant-deployment, multiplier-thesis, working-name-pending, substantive-applicability
---

# The platform must be substantively applicable to target orgs, not just rebranded

When we pitch the platform we own to any new org (peak body, land trust, CLT, conservation co-op, collective-care charity), the offer must be honest about whether the platform's core ACTUALLY fits that org's shape, or whether we are quietly committing to a rewrite under the marketing of "configurability." Rebranding is a wording fix. Substantive applicability is an engineering and product fix that has to be true before the deck reaches the prospect.

This is the sibling pattern to `coexist-vs-platform-ip-separation.md`. That one handles ownership/naming. This one handles whether what we sell will actually work.

## The drift this fixes

Saying "the platform is multi-tenant, we just configure it for your org" while privately knowing the platform is currently shaped around one specific deployment (Co-Exist's specific data shape, conservation-event-centric flows, charity-specific assumptions) and would need real engineering to fit a different org. That's a hand-wave. Prospective tenants who buy on the hand-wave become discounted-build clients, not platform tenants. Margin collapses. Trust collapses on the second prospect's referral call.

## The two-layer test - apply before any external pitch

The platform offer must answer two questions cleanly:

**1. Generic core - does the org-shape map to ours without rewrite?**

The platform's core supports collective-care orgs with this shape:
- Members (people who participate, contribute time / labour / skills / capital)
- Branches or sub-units (Connection / Knowledge / Practice for Y&Y; regions for a federation; chapters for a peak body)
- Events / working bees / operational gatherings
- Impact tracking (trees, kg, hours, attendees - whatever the org measures)
- Operational sync from spreadsheet/legacy tools to canonical data the org owns

If the prospect's org maps cleanly onto this shape, the core fits and Tier-2 pricing is honest. If the prospect's org needs something fundamentally different (e.g. a marketplace, a real-time collaboration tool, a hardware-IoT integration), then it's not a platform deployment. It's a custom build, priced and scoped accordingly.

**2. Per-tenant configuration - what gets adapted, and is it bounded?**

Per-tenant work is configuration, not rewrite. Acceptable configuration:
- Branding / theming / domain
- Branch and sub-unit names + structure (Y&Y three-branch, Landcare regions)
- Custom impact metrics for the org
- Events / activity types specific to the org
- Member roles, contribution categories, capital flows specific to the org

Unacceptable configuration (these are rewrites, not config):
- Different fundamental data model
- Different integration spine
- Different auth model
- Different platform architecture (e.g. moving from members + events to a marketplace)

If the prospect needs unacceptable-configuration changes, that is a custom-build conversation, not a platform tier conversation.

## Do

- Before drafting any platform pitch, name the prospect's org-shape and verify it maps to the generic core in plain English. One paragraph, internal note. If it does not map, the pitch is wrong.
- In the deck itself, name the org-shape mapping explicitly. Slide-level: "your three branches map to our branches model"; "your impact metrics map to our impact tracking"; "your operational tools map to our sync layer." Concrete, not hand-wave.
- Mention the lighthouse deployment (Co-Exist) only as evidence the core works in production, anonymised by default per public-writing doctrine.
- Distinguish in the deck between the generic core and per-tenant configuration. Prospects need to see both layers so they understand what they are buying.
- Internally, when an unacceptable-configuration request comes up, treat it as a fork-in-the-road decision: either (a) genericise the core to absorb it (engineering investment, decided by Tate), or (b) price as custom build with explicit scope.
- When pitching a tier, make sure the tier's price reflects whether the deployment is config-only or includes core extension work. They are not the same margin.

## Do not

- Write "the platform is configurable for any org" without testing the org-shape mapping. That's the hand-wave that produces unhappy clients.
- Promise a Tier-2 deployment for an org whose shape requires unacceptable-configuration changes. Either upgrade the core first or scope it as custom build.
- Use the IP-separation pattern as a substitute for this one. Renaming "Co-Exist platform" to "platform we own" does not make the platform substantively portable. Both patterns must be checked before shipping a pitch.
- Approve a Factory dispatch to "build a tenant for [org]" without verifying the org-shape maps cleanly. The Factory session will succeed at producing a fork, not a tenant.

## Verification protocol

Before shipping any external platform pitch (deck, brief, contract, email proposal):

1. State the prospect's org-shape in one paragraph: members? branches? events? impact metrics? operational sync? something else?
2. Map each element to the generic core's capabilities. Each element is either (a) directly supported, (b) supported via per-tenant configuration, or (c) requires core extension.
3. Count (c) items. Zero or one is fine. Two or more = decision needed before the pitch lands. Either upgrade the core or scope as custom build.
4. Make the mapping visible in the pitch (one slide minimum). The prospect sees the same audit you did, in their language.
5. Pricing tier reflects (a)+(b) only. Any (c) work is priced separately as a one-off engineering line, not folded into platform tier.

## Affected artefacts (as of 2026-04-27)

- `~/ecodiaos/drafts/yarn-and-yield/yarn-and-yield-deck-v0.2.html` - reflects this pattern. Slide 6 ("The platform, briefly") explicitly distinguishes generic core from per-tenant configuration.
- `kv_store ceo.briefs.platform-coexist-*` keys - content needs a rewrite pass to apply the two-layer test before any external derivative ships.
- `ceo.briefs.platform-coexist-pricing-benchmarks-2026-04-25` and `ceo.briefs.platform-coexist-federation-thesis-2026-04-26` - pricing tiers must be re-checked against the (c)-counts-zero rule. If the proposed Landcare deployment requires core extensions, those are scoped separately.
- Any future Landcare / CETIN / peak-body pitch deck - blocked on the verification protocol above.
- Neo4j Decision _id 2637 ("Platform must be substantively applicable to target orgs, not just rebranded") is the canonical capture of Tate's directive that authored this pattern.

## Origin

2026-04-27 ~00:25 AEST. Tate's directive in a multi-thread message: "we need to make sure that the platform we build for co-exist, if duplicatee and generalised, is actually paplicable to the orgs we'd sell it to + then change it to fit ither needs etc. I need to actual." Sibling to the same-day IP-separation directive ("Co-Exist is Kurt's"), but distinct - that one was about wording, this one is about whether the offer holds up under actual deployment. The drift this fixes had been building inside the Multiplier Thesis framing where "platform white-labelled" was treated as if a rebrand was sufficient. It is not. The first prospect who pays for a Tier-2 deployment will reveal the gap if the platform is not substantively portable. Logging here so any future session drafting a platform pitch hits this rule via grep before the deck ships.
