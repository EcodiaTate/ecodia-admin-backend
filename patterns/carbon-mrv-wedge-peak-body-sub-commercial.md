---
triggers: carbon, mrv, dmrv, accu, peak-body, agriprove, greencollar, fullcam, cer-submission, conservation-platform, soil-carbon, cfi-mer, biodiversity-credit, nature-repair, landcare, nrm, indigenous-carbon
---

# Carbon MRV wedge - peak bodies aggregating sub-commercial-scale projects, software-only dMRV at $1.5k/mo

## The rule

When pricing or scoping any carbon / nature-repair / biodiversity-credit MRV product, the wedge is **peak bodies and aggregator networks running sub-commercial-scale projects** (single-property holdings, Indigenous co-managed land, community Landcare groups, NRM regional bodies). NOT individual large landholders, NOT direct competitors to AgriProve / GreenCollar.

The price model is **fixed software subscription, not revenue share**. Default shape:
- $5-7k/mo enterprise tier (peak body or NRM region operating the platform)
- $1.5k/mo MRV add-on per active method stream
- Per-project issuance fee on successful CER registration ($500-2,000 per project)
- **NEVER take a percentage of credit revenue.** That is GreenCollar's lane (~30% take) and putting Ecodia into it competes with the wrong people on the wrong economics.

## Why this wedge exists

1. **AgriProve owns ~70% of soil-carbon project starts.** Their economics work because they aggregate large landholders into single CFI-MER-2018 submissions. Sub-commercial projects (under ~500ha or fragmented title) don't fit their model - the per-hectare admin overhead crushes margin.
2. **GreenCollar takes ~30% revenue share** on biodiversity / vegetation methods. That's an aggregator-financier model. Peak bodies running their own member projects don't want to give up 30% of credit value to an external aggregator.
3. **The CER's blessed model is FullCAM** for soil. FullCAM is a black box for most peak bodies. They need a software wrapper that produces FullCAM-compatible inputs from ground truth + remote sensing, not a replacement for it.
4. **The AU ACCU market grows from 19.5M (2024) to 33.3M ACCUs (2034), CAGR 5.93%.** The wedge isn't in stealing AgriProve volume - it's in absorbing the long tail of sub-commercial peak-body-led projects that currently can't economically participate.

## Do

- Price as **software subscription + issuance fee**. Predictable revenue, IP retained, recurring.
- Lead with the peak-body-as-platform-operator framing. They run the platform, they support their members, they own the relationship. We are infrastructure, not aggregator.
- Wrap FullCAM for soil. Wrap CFI-MER-2018 submission templates. Don't reinvent.
- Use Supabase reverse-Excel-sync substrate (project `tjutlbzekfouwsiaplbr`) for field data → MRV pipeline. EOSDA satellite layer for remote-sensing.
- Target Tier 1 first: Landcare Australia (Kurt + Co-Exist board warm intro), NRM Regions Australia (CEO Marnie Lassen), Indigenous Carbon Industry Network (co-chairs Cissy Gore-Birch + Dean Yibarbuk, ~half AU landmass under member control).
- Ship the technical spec (mrv-addon-technical-spec-v1.md) alongside any commercial conversation. The technical depth is the moat against generic SaaS pitches.
- Treat biodiversity / Nature Repair Market methods as the same wedge applied to a different method library. Same architecture, same pricing, different schema.

## Do NOT

- Do not propose revenue share. That competes with GreenCollar economics on GreenCollar's home turf. Lose-lose.
- Do not pitch direct-to-large-landholder. AgriProve already owns those. Different sales motion entirely.
- Do not build our own CFI method. Wrap CER-blessed methods. Method development is a 3-year regulatory cycle and is not our edge.
- Do not bundle into a generic conservation platform sale. The MRV add-on is a discrete commercial product with its own price line. Bundling hides the recurring revenue and weakens the conversation.
- Do not name specific peak-body warm-intro paths (Kurt, Co-Exist board, named CEOs) in any external-facing artefact. That intelligence is INTERNAL-tagged and lives in `drafts/conservation-platform-rebrand/peak-body-target-list-v1.md`.
- Do not assume any peak body has technical capacity to integrate themselves. Implementation is a paid service ($10-25k onboarding) on top of subscription.

## Verification protocol before pitching

1. Read `drafts/conservation-platform-rebrand/federation-pitch-deck-v2.html` for the current commercial framing.
2. Read `drafts/conservation-platform-rebrand/mrv-addon-technical-spec-v1.md` for the engineering backstop.
3. Read `drafts/conservation-platform-rebrand/peak-body-target-list-v1.md` (INTERNAL) for warm-intro paths.
4. Check Neo4j Episode 3099 ("Carbon-MRV GTM bundle shipped 2026-04-27") and the Research node it EXTENDS for the underlying market analysis.
5. Confirm pricing matches this pattern: $5-7k/mo + $1.5k/mo add-on + per-project fee. If a conversation pushes towards revenue share, push back.

## Origin

Apr 27 2026, ballistic-mode parallel-fork session during Tate's Kilimanjaro absence. Six-deliverable carbon-MRV GTM bundle shipped: market research (Episode 3079), federation pitch deck v2, MRV technical spec v1, peak-body target list v1 (INTERNAL), Quorum of One 004 (KYA framework), CER submission template anatomy research, Indigenous aggregation models research. The wedge thesis crystallised when the AgriProve 70% / GreenCollar 30% market structure was mapped against the sub-commercial peak-body long tail - the gap is real, the price model that closes it is software-not-share. Codified here so future sessions surface the doctrine via grep before drafting any carbon-related quote, deck, or outbound message.
