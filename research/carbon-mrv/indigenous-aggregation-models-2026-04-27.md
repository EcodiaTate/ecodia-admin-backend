# Indigenous carbon farming aggregation models in Australia

Research note for the carbon MRV thread (Neo4j Research 3079). Author: EcodiaOS, fork fork_moh61xno_d7dd1a. Date: 27 Apr 2026.

## Why this matters for Ecodia

Indigenous-owned and Indigenous-led carbon projects already cover roughly half of the Australian landmass and produce around 1.2 million ACCUs per year out of about 35 savanna fire management projects, plus a handful of vegetation projects. The peak body, the Indigenous Carbon Industry Network (ICIN), counts 23 Indigenous land and sea management organisations as members and represents about $59 million of annual ACCU revenue across northern Australia under the Emissions Reduction Fund and voluntary markets [1][2].

This is the largest concentration of sub-commercial peak-body carbon activity in Australia that does not yet have a single dominant digital MRV vendor sitting under it. AgriProve dominates soil carbon and GreenCollar dominates broadacre vegetation, but both extract significant revenue share. The Indigenous segment runs on ranger-collected field data, paper records, GIS uploads, and the Department-supplied SavBAT (now SavCAM) calculation tools [3][4]. That gap is precisely the shape of the peak-body dMRV layer Ecodia is positioning.

The nuance: this is not a generic vendor sale. Cultural data sovereignty, Free Prior and Informed Consent, governance structures, and political optics all constrain how a non-Indigenous-led tech org can engage. The doctrine in the second half of this note matters as much as the org map in the first half.

## The aggregator landscape

### 1. Aboriginal Carbon Foundation (AbCF)

100 percent Aboriginal-owned not-for-profit, established 2010, headquartered in Cairns. Operates the Aboriginal Carbon Fund (a charitable buying-and-selling vehicle for Indigenous ACCUs) and runs the Core Benefits Verification Framework, the only Indigenous-led, peer-reviewed co-benefits verification standard in Australia. Embedded in the Queensland Land Restoration Fund as the third-party assurance layer for First Nations co-benefits claims [5][6].

Role: hybrid. AbCF is sometimes a project proponent, sometimes a buyer-and-on-seller of credits, sometimes a verifier of co-benefits on credits issued by other proponents. It buys credits at a premium from Indigenous producers and sells with the verified social and cultural co-benefits attached. All profit on credit sales returns to Traditional Owners under their stated model. The Kowanyama Savanna Burning Project alone has driven over $1 million to Kowanyama Aboriginal Shire Council via this pathway [7][8].

Methods: savanna fire management is the core. AbCF also references cultural fire credits (a non-ACCU instrument) and is positioned for emerging methods including blue carbon and savanna sequestration. Has a 2024 to 2029 strategic plan signalling expansion [9].

Best-fit indicator for Ecodia: high. Multi-project portfolio, no public technology partner, peer-led verification model that is data-heavy, and an explicit interest in connecting Indigenous producers to the corporate ACCU market with co-benefits attached. The CBVF data flow is exactly the kind of bi-temporal evidence trail a software dMRV layer can compress.

### 2. Indigenous Carbon Industry Network (ICIN)

The peak body. Aboriginal-owned, not-for-profit, charitable. Hosts 23 full member organisations and a growing list of associate members, including the Indigenous Land and Sea Corporation, Indigenous Desert Alliance, and Jagun Alliance (the network's first NSW associate member). ICIN does not run projects directly. It convenes the industry, runs the First Nations Carbon Farming Outreach Program, makes submissions to government, and shapes method development [10][11].

Role: convenor, advocate, industry development. Not a proponent.

Best-fit indicator for Ecodia: very high as a relationship gateway. ICIN cannot procure dMRV on behalf of its members (members have veto rights over their own projects), but ICIN can endorse a vendor, run a tech showcase, or co-author a member-friendly digital MRV reference architecture. Approaching the segment via ICIN first is the right move politically.

### 3. Arnhem Land Fire Abatement (NT) Limited (ALFA NT)

Aboriginal-owned carbon business covering more than 80,000 km² of Aboriginal freehold land across western, central, and eastern Arnhem Land. Registered project proponent for five savanna burning projects under the ACCU scheme. Currently the largest single producer of savanna burning ACCUs, having earned over 4.8 million ACCUs cumulatively. All income from ACCU sales is reinvested into Aboriginal ranger groups and Traditional Owner community development [12][13].

Role: pure proponent, multi-project. ALFA holds the project registrations and contracts; member ranger groups (Warddeken, Mimal, Djelk, Arafura Swamp, others) deliver on-country fire management.

Methods: savanna fire management (emissions avoidance and the new sequestration variant under the 2018 method, plus the 2026 successor methods).

Best-fit indicator: high. ALFA is exactly the multi-project, peak-body-style aggregator with no internal MRV tech that the dMRV pitch is designed for. The ALFA-to-member-ranger structure also means a single technology engagement scales across multiple sub-projects.

### 4. Kimberley Land Council (KLC) and the North Kimberley Fire Abatement Project (NKFAP)

Six fire management projects registered under the ERF across the four north Kimberley native title groups (Dambimangari, Wilinggin, Wunambal Gaambera, Balanggarra). KLC facilitates; the native title groups hold the projects. Over one million ACCUs generated to date across the partnership [14][15].

Role: facilitator-aggregator. KLC provides the central project management, scientific support, and reporting capability. The native title groups are the proponents.

Best-fit indicator: medium-high. KLC has the institutional weight to specify a dMRV system and the volume to justify it, but the four-group governance structure means any platform must be configurable per group, with strict data partition.

### 5. Indigenous Land and Sea Corporation (ILSC)

Commonwealth corporate entity established under the Aboriginal and Torres Strait Islander Act 2005. Owns Fish River Station (180,000 hectares, south of Darwin), the first Indigenous project registered under the Carbon Farming Initiative. ILSC is the registered proponent and operates the project in collaboration with Traditional Owners. Has continued ACCU sales annually since the foundational sale to Caltex Australia [16][17].

Role: government-aligned proponent on Indigenous-owned property held in trust pending hand-back. Also an associate member of ICIN and a broader funder of land and sea management activity.

Best-fit indicator: medium. ILSC is unlikely to procure new dMRV outside government tendering, but the Fish River project is a useful reference benchmark and ILSC is a credible early-stage validator.

### 6. Member ranger organisations operating under aggregator umbrellas

Worth naming separately because they are the ground-truth data producers and any dMRV system has to land in their hands:

- **Warddeken Land Management Ltd** (West Arnhem). About 150 Indigenous rangers a year. Operates fire management, weed control, rock art, education programs from Kabulwarnamyo, Mamardawerre, Manmoyi. Project activity flows through ALFA NT [18].
- **Mimal Land Management** (Central Arnhem). Producer in the Central Arnhem Land Fire Abatement (CALFA) project alongside Djelk Rangers and Arafura Swamp Rangers Aboriginal Corporation [19].
- **Tiwi Land Council and Tiwi Resources** (Tiwi Islands). The Tiwi Carbon Study (Tiwi Land Council with Charles Darwin University) underpins fully Indigenous-owned carbon enterprise development [20].

These are the field nodes. They typically have low-bandwidth connectivity, mixed device fleets, and ranger-led data collection workflows.

### 7. Adjacent and emerging entities

- **Jagun Alliance** (NSW). ICIN's first NSW associate member. Signal that Indigenous carbon is expanding beyond northern savanna into temperate vegetation methods.
- **Aboriginal Carbon Industry Strategy 2030**. Repeatedly referenced in industry materials as a forward-looking strategy framing for the sector. Specific text and ownership of the strategy is not consistently published. Treat as directional rather than authoritative until confirmed with ICIN or AbCF directly.

## Revenue distribution model: what the public record shows

Specific percentage splits between aggregator, broker, and Traditional Owner group are not consistently disclosed. The publicly documented patterns:

- **AbCF** states that all profits from credit sales return to Traditional Owners. AbCF retains a margin embedded in the buy-low-sell-high spread (the premium it secures by attaching CBVF co-benefits) and is a registered charity, so any retained surplus funds operations and grants [7].
- **ALFA NT** reinvests 100 percent of credit-sale income back into ranger groups and Traditional Owner community development, by its own statement. ALFA itself is the corporate vehicle owned by those same ranger groups [12].
- **General CFI aggregator pattern** (non-Indigenous default): the aggregator takes a development fee, an annual management fee, and a share of issuance revenue. AgriProve has been observed at around 70 percent of soil carbon project starts, GreenCollar at around 30 percent revenue share on broadacre vegetation. The Indigenous-owned aggregators above structure to avoid that extraction profile by design [21][22].

The technical implication for dMRV: the platform should make revenue tracking and benefit-distribution reporting first-class fields in the data model rather than a side spreadsheet. Indigenous proponents need to be able to evidence the 100 percent retention claim to philanthropic and corporate buyers. That capability is a feature; it is also product-defining.

## Cultural data sovereignty: what it means technically

Indigenous Data Sovereignty (IDSov) and Indigenous Data Governance (IDGov) are the operating frameworks. The collective work in Australia is led by the Maiam Nayri Wingara Indigenous Data Sovereignty Collective, which asserts the right of Indigenous Peoples to autonomously decide what, how, and why Indigenous Data are collected, accessed, and used. The CARE Principles (Collective Benefit, Authority to Control, Responsibility, Ethics) developed by the Global Indigenous Data Alliance are the global complement to the FAIR principles, and where the two conflict, CARE prevails [23][24][25][26].

Concrete technical translations for an Ecodia dMRV layer:

1. **Data residency**. All Indigenous data should sit in Australian-resident infrastructure. Supabase regional pinning (ap-southeast-2 / Sydney) is the floor. Cross-border processing of any kind needs explicit consent.
2. **Authority to control**. Per-organisation data ownership, hard-partitioned by tenant. The proponent can export, audit access logs, and revoke. Multi-tenant architecture by default; never shared schemas across communities.
3. **Granular access controls**. Cultural sites, sacred sites, and gendered knowledge layers may need to be invisible to specific user roles. The system has to support hide-from-view-by-role for spatial layers in addition to row-level security on records.
4. **Termination clause as a real feature**. On partnership termination, the proponent gets a complete export in open formats, full audit trail, and the operator destroys all copies. Encrypted destruction certificates are reasonable to provide.
5. **No model training on Indigenous data**. Default off for any AI features. Anonymous aggregates only with explicit opt-in. No syndication to global datasets.
6. **Display sovereignty in the UI**. Show the data-governance posture in the product itself rather than burying it in the contract. A persistent banner per project showing "Data resident in Sydney. Owned by [Org]. Last access export available." builds trust faster than a clause buried in an MSA.

## Political and partnership posture

A non-Indigenous-led tech org partnering in this space sits in a sensitive position. The defensible posture is supplier; co-brand is risky; white-label is off the table. Specifically:

- **Supplier model**. Ecodia provides the dMRV software layer underneath the proponent's brand. The proponent is the public-facing entity. Ecodia is named in technical documentation and audit reports where required.
- **No claim to Indigenous endorsement that has not been explicitly granted in writing**. Industry endorsements (ICIN, AbCF) require formal agreement and are not implied by paid engagements.
- **Indigenous procurement compliance**. Engage the Supply Nation pipeline where appropriate. Recognise that some buyers will require Indigenous business as the contracting counterparty, in which case Ecodia operates as a sub-supplier under an Indigenous-owned head contractor.
- **Cultural induction is a real cost line**. Budget for ranger-side training time, on-country visits where invited, and language-appropriate documentation. This is not corporate social responsibility window dressing; it is the actual product spec.
- **Open the kimono on the data model**. Indigenous proponents should see the schema, the access logs, and the deletion procedure on day one. Anything less reads as extraction.

The political risk of getting this wrong is not just commercial. It can foreclose the entire segment. The political upside of getting it right is that one good reference engagement (with ALFA NT, AbCF, or under ICIN endorsement) compounds across the network because the segment is small and tightly connected.

## Three highest-leverage targets for Ecodia

1. **ICIN**. Engage as a member-aligned tech vendor seeking endorsement or panel inclusion. Path: introductory call, offer to present at the next Indigenous Carbon Forum, propose a member-friendly reference architecture that ICIN co-authors. Goal: a technology readiness statement that ICIN members can cite when procuring.
2. **Aboriginal Carbon Foundation**. The CBVF data trail is the cleanest fit for a digital MRV plus co-benefits evidence layer. Path: scoped pilot to digitise CBVF verification capture for one project, with the explicit goal of compressing audit prep time. Pricing should be flat-fee per project. No revenue share on credits.
3. **ALFA NT**. The largest single producer of savanna ACCUs and a multi-project proponent without a public dMRV vendor. Path: technical conversation framed around SavCAM ingestion, fire scar mapping integration, and offsets report compression. Avoid lock-in language; offer 30-day independent kill switch to remove vendor risk.

In all three cases, lead with the technical conversation and let the commercials emerge from the use case. Lead with pricing and the doors close.

## Sources

1. [Indigenous Carbon Industry Network: About / What is the Indigenous Carbon Industry](https://www.icin.org.au/the_indigenous_carbon_industry)
2. [ICIN: Who we are](https://www.icin.org.au/who_we_are)
3. [Clean Energy Regulator: Savanna fire management methods](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/accu-scheme-methods/savanna-fire-management-methods)
4. [SavBAT: Savanna Burning Abatement Tool](https://savbat.environment.gov.au/)
5. [Aboriginal Carbon Foundation: Core Benefits Verification Framework](https://www.abcfoundation.org.au/core-benefits-verification-framework)
6. [AbCF on the Land Restoration Fund](https://www.abcfoundation.org.au/land-restoration-fund)
7. [The Fifth Estate: AbCF connects Indigenous carbon farmers to the big end of town](https://thefifthestate.com.au/business/indigenous-business-series/aboriginal-carbon-foundation-connects-indigenous-carbon-farmers-to-big-end-of-town/)
8. [DCCEEW case study: Aboriginal Carbon Foundation](https://www.dcceew.gov.au/environment/partnerships/case-studies/aboriginal-carbon-foundation)
9. [AbCF: Our Story and Vision](https://www.abcfoundation.org.au/our-story)
10. [ICIN: First Nations Carbon Farming Outreach Program](https://www.icin.org.au/fn_carbon_farming_outreach_program)
11. [ICIN September 2025 Update](https://www.icin.org.au/september_2025_update_from_the_network)
12. [ALFA (NT) Limited at ICIN](https://www.icin.org.au/alfant)
13. [Carbon Market Institute: ALFA (NT) Limited](https://carbonmarketinstitute.org/organisations/alfa-nt-limited/)
14. [Kimberley Land Council: Savanna Burning Carbon Projects](https://www.klc.org.au/savanna-burning-carbon-projects)
15. [CER: Fighting fire with fire (Kimberley case study)](https://cer.gov.au/news-and-media/case-studies/fighting-fire-fire)
16. [ILSC: Fish River, Australia's first savanna burning project](https://www.ilsc.gov.au/home/news/fish-river-australias-first-savanna-burning-project/)
17. [ILSC: First Indigenous carbon credits to go on market](https://www.ilsc.gov.au/home/news/first-indigenous-carbon-credits-to-go-on-market/)
18. [Warddeken Land Management at ICIN](https://www.icin.org.au/warddekenlandmanagement)
19. [Mimal Land Management at ICIN](https://www.icin.org.au/27)
20. [Tiwi Land Council: Tiwi Carbon Study](https://www.tiwilandcouncil.com/296/tiwi-carbon-study)
21. [CER: Aggregate emissions reduction projects or contracts](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate/plan-your-project/aggregate-emissions-reduction-projects-or-contracts)
22. [Carbon Market Institute: Carbon Farming Contracts Guidance Note](https://carbonmarketinstitute.org/app/uploads/2023/11/CMI-Carbon-Farming-Contracts-Guidance-Note-1.pdf)
23. [Maiam Nayri Wingara: Indigenous Data Sovereignty Collective](https://www.maiamnayriwingara.org)
24. [Maiam Nayri Wingara: Principles](https://www.maiamnayriwingara.org/mnw-principles)
25. [Global Indigenous Data Alliance: CARE Principles](https://www.gida-global.org/care)
26. [ARDC: The CARE Principles for Indigenous Data Governance](https://ardc.edu.au/resource/the-care-principles/)
