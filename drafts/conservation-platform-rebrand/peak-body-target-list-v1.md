[INTERNAL]

# Carbon-MRV Go-To-Market Target List v1

Author: EcodiaOS (fork fork_moh658e2_609431)
Date: 2026-04-27
Status: Draft for Tate review. No outbound contact off the back of this document until Tate green-lights per the no-unilateral-client-contact rule.
Distribution: internal only. Contains operational warm-intro paths (Kurt, Co-Exist board) that are not for any external audience.

---

## TL;DR

The wedge is peak bodies and Indigenous aggregators that already gather sub-commercial carbon and biodiversity projects on behalf of small landholders, ranger groups, or community networks. They have the governance structures, the funder relationships, and the trust to onboard projects at scale. They lack the software layer that turns spreadsheet-and-PDF evidence into a CER-compliant submission pipeline. AgriProve and GreenCollar do not serve them because the per-project economics are too thin for revenue-share. Gentian, NatureMetrics, and the global observation-layer plays do not serve them because the gap is administration rather than measurement.

The three highest-conviction targets are Landcare Australia (warm-intro path via Kurt and the Co-Exist board, lighthouse deployment is already inside the network), NRM Regions Australia (peak body for the 54 regional NRM bodies, just transitioned to incoming CEO Marnie Lassen, runs a Nature-based Solutions Community of Practice), and Indigenous Carbon Industry Network (Aboriginal-owned peak body, 23 member organisations managing approximately half the Australian landmass, Cissy Gore-Birch and Dean Yibarbuk co-chair the board). Approach in that order, two to three weeks apart, because each one's response shapes how we frame the next.

---

## The Offering In One Paragraph

Conservation operations platform on Capacitor + Supabase + Edge Functions, multi-tenant, six months in production at the lighthouse deployment. Enterprise tenant tier sits in the $5,000 to $7,000 per month range. The MRV add-on is software-only digital MRV, $1,500 per month on top, designed for sub-commercial-scale carbon and biodiversity projects that fall through the cracks of existing project-developer SaaS. The build fee covers per-tenant configuration. The platform IP stays at Ecodia Labs Pty Ltd. The buyer holds a perpetual, non-transferable operating licence for their deployment, contingent on subscription. Termination is 30 days either side. Their data stays theirs, in full, with export available on request.

---

## Tier 1: Highest Conviction (Pursue First)

### 1. Landcare Australia

**Role:** 35-year-old national peak body. Operates the Landcarer platform, the National Landcare Directory, and the Junior Landcare program. Delivers federal grants, runs Landcare Week, and aggregates roughly 6,000 community Landcare groups and 100,000 to 140,000 volunteers across Australia.
**Geography:** National, with regional networks state by state.
**Project portfolio scale:** 6,000 groups in the network. 12,000+ Junior Landcare groups and schools registered on the National Landcare Directory and the Woolworths Junior Landcare Map. Direct carbon project portfolio is small at the national-org level; the carbon and biodiversity activity sits in the regional networks and individual landholders that Landcare connects.
**The right human:** Shane Norrish (CEO) for the strategic conversation. Ben Elvy (General Manager, Programs and Projects) for the operational fit conversation about Landcarer roadmap. Confirm via warm intro before any direct address.
**Opening hook:** The Landcarer "Have your say in the future of Landcarer" page is open and the Landcare Week 2026 Survey is collecting field input. The platform's roadmap is genuinely under review. The lighthouse deployment running inside their network already does what the Landcarer feedback page suggests are gaps: offline event check-in, idempotent two-way sync to a SharePoint master sheet on a 30-minute schedule, configurable impact metrics per local group, and a leader hierarchy that maps to a federated peak-body shape.
**Why they fit:** The shape of Landcare Australia (regional groups feeding state networks feeding a national directory) is the exact federation shape the platform was designed for. Junior Landcare's 12,000 schools are the events module's specific use case. The MRV add-on slots in for Landcare-network landholders enrolling in NRM or ACCU projects under the Replanting Native Forest method.
**What they would pay:** Enterprise tier in the $7,000 per month range given the 6,000-group scale. MRV add-on at $1,500 per month, contingent on at least one of their networks running active carbon project enrolment.
**What we would learn:** Whether peak-body procurement panels accept the AI-LLC structure when the lighthouse deployment is sitting in production at one of their network charities. If yes, the Landcare deal becomes the proof point for every other org in this list.

### 2. NRM Regions Australia

**Role:** National peak body for the 54 regional Natural Resource Management organisations across Australia. Provides advocacy, capability-building, innovation, and strategic influence on policy and investment. Coordinates a Nature-based Solutions Community of Practice and a carbon and environmental markets discussion group that meets every six to eight weeks.
**Geography:** Canberra-based, members across every state and territory.
**Project portfolio scale:** Members include the six regional NRM organisations selected for the federal Carbon + Biodiversity Pilot (Burnett-Mary QLD, Central West NSW, North Central VIC, NRM North TAS, Eyre Peninsula SA, South West WA). Across the 54 members the project portfolio covers tens of thousands of landholders and project-level carbon and biodiversity enrolment that varies wildly in maturity.
**The right human:** Marnie Lassen (incoming CEO, commences early May 2026) is the primary target once she lands. Bek Christensen (Director) and Kate Andrews (outgoing CEO, transitions mid-2026) are the warm-intro pathway during the handover window.
**Opening hook:** The carbon and environmental markets discussion group is the room where the 54 members are jointly working out how to advise their landholders on carbon project enrolment. The lighthouse deployment is already running the operational spine for a charity in their members' demographic. Most regional NRM bodies are running landholder onboarding on spreadsheets. We can show, at one of their members, what the alternative looks like in production.
**Why they fit:** The peak body itself is not the buyer; their member NRM organisations are. NRM Regions Australia is the channel that gets us in front of 54 regional bodies in one conversation. The substantive-applicability test holds: regional NRM bodies have members, local groups, events, impact tracking, and operational sync against funder reporting templates. The MRV add-on is a natural extension because every regional NRM body is being pressed by their landholders to advise on Nature Repair Market enrolment, and none of them have a tool for it.
**What they would pay:** Peak body itself takes a coordination/showcase fee in the $2,000 to $3,000 per month range. Each regional NRM body that enrols pays the enterprise tier ($5,000 to $7,000 per month) plus MRV add-on. Realistic capture: three to five regional NRM bodies in the first 18 months.
**What we would learn:** Whether the enterprise tier number holds against a member organisation budget that is mostly grant-funded. If they push back hard on price, we learn the upper bound for regional-NRM-tier pricing fast. The Marnie Lassen transition is also the right moment to be in the room because incoming CEOs run discovery conversations.

### 3. Indigenous Carbon Industry Network (ICIN)

**Role:** Aboriginal-owned peak industry body for the Indigenous carbon industry. 23 Indigenous land and sea management organisations as members, including the Kimberley Land Council, Northern Land Council, Central Land Council, Balkanu Development Corporation, Tiwi Resources, and NAILSMA. Members and partners manage carbon and nature-repair projects across approximately 50 percent of the Australian landmass.
**Geography:** Darwin-headquartered, members across northern Australia and increasingly into the desert and central regions.
**Project portfolio scale:** Roughly 78 savanna burning projects across northern Australia (per 2018 baseline; the 2024 New Savanna Fire Management method is already producing additional projects). Member organisations have produced over 4 million ACCUs since the original method launched. Cultural Fire Credits, developed by the Aboriginal Carbon Foundation under ICIN's industry umbrella, are an additional revenue stream.
**The right human:** Anna Boustead (CEO). Co-Chairs Cissy Gore-Birch and Dean Yibarbuk lead the board. The operational fit conversation goes through Anna; the cultural and governance conversation goes through the co-chairs.
**Opening hook:** The new Savanna Fire Management method launched in 2024 expanded the eligible project pool. ICIN members are now running multi-method portfolios (savanna fire, cultural fire, increasingly biodiversity) on tooling that was built for single-method savanna projects. The platform's multi-tenant architecture supports a per-member deployment with the MRV layer configured to whichever methods that member's projects run under, and the operational sync layer keeps the existing reporting templates intact.
**Why they fit:** ICIN is the textbook peak-body wedge: 23 member orgs, governance structure intact, software layer absent. The MRV add-on leads the conversation here; the operational platform is secondary, because their members are already running carbon projects and the pain is on the verification side. Existing global MRV platforms (Gentian, NatureMetrics) are not Australian-specific and do not handle ACCU certification submission. AgriProve does not aggregate Indigenous projects under their commercial structure. The wedge is wide open.
**What they would pay:** ICIN as a peak-body coordination layer at $3,000 per month. Per-member deployments at the enterprise tier plus MRV add-on, scaling with member uptake. Indigenous-organisation budget cycles run on grant funding so the build fee structure has to allow for triggered deferred payment (delivered + funding tranche) rather than calendar-date payment.
**What we would learn:** Whether the AI-LLC structure is acceptable to an Aboriginal-owned peak body and their member governance. This is the diligence conversation that matters most. If it works here, it works anywhere in the conservation sector. The cultural and governance bar is highest at ICIN, so passing it is the strongest credential we can earn.

### 4. Aboriginal Carbon Foundation (AbCF)

**Role:** 100 percent Aboriginal-owned not-for-profit, established 2010. Develops Cultural Fire Credits, partners on savanna burning projects, runs the Carbon Farming program, and is an ICIN member. Distinct from ICIN in that AbCF runs projects directly and has its own infrastructure, where ICIN is the industry peak body.
**Geography:** Northern Australia primary, expanding south.
**Project portfolio scale:** Cultural Fire Credit framework. Multiple savanna burning projects in their portfolio. Partnership pipeline includes Caritas Australia and other corporate partners on the demand side.
**The right human:** Rowan Foley (CEO and Cultural Fire Credit architect). Long-tenured, sector-respected, and the visible spokesperson for Indigenous carbon.
**Opening hook:** Cultural Fire Credits are a methodology AbCF originated. The infrastructure to run a Cultural Fire Credit project, including the cultural-knowledge evidence layer, is bespoke to AbCF and currently sits in custom tooling. The platform's per-tenant configurability handles culturally-specific evidence schemas (geotag, hours, cultural-practitioner attribution, photo evidence) without forcing AbCF to flatten their model into a generic carbon-project schema.
**Why they fit:** AbCF is the buyer where ICIN is the channel. They have a project-developer's workflow problem (intake, monitoring, certification submission, reporting to corporate buyers) and they would rather pay $6,500 per month for a tool that fits their model than $0 for a tool that does not exist plus the staff time to keep running on spreadsheets.
**What they would pay:** Enterprise tier at $6,500 per month plus MRV add-on at $1,500 per month, with an explicit Cultural Fire Credit configuration scoped in the build fee.
**What we would learn:** Whether the platform handles culturally-specific evidence requirements without forcing the buyer into a generic schema. If yes, the same configurability holds for Junior Landcare's school-and-teacher hierarchy, for Coastcare's marine-survey schema, and for any future tenant whose shape diverges from the lighthouse deployment.

---

## Tier 2: Plausible Fit (Pursue After Tier 1 Signal)

### 5. Greening Australia

**Role:** National conservation NFP. Largest producer of ACCUs under the Environmental Plantings method per the Clean Energy Regulator. 35-year-old organisation with a national footprint and significant corporate partnership pipeline (Woodside, Conscious Investment Management, others).
**Geography:** National.
**Project portfolio scale:** January 2025 investment in the 3,313-hectare O'Kiltabie property in South Australia for ~900,000 native plantings over 2026/27. Multiple environmental plantings projects in the ACCU registry. Carbon project developer at scale.
**The right human:** Heather Campbell (CEO, formerly Bush Heritage Australia CEO). She knows the conservation operations problem from the buyer side at Bush Heritage and the project-developer side at Greening Australia.
**Opening hook:** Greening Australia is not a sub-commercial aggregator; they are at scale. The fit is on the project-administration side, where a 3,313-hectare project is being managed across thousands of plantings, multiple verifiers, and a 25-year monitoring tail. The platform's operational sync layer for their existing SharePoint and reporting templates is the primary hook; the MRV add-on is secondary because they likely have their own MRV stack at this scale.
**Why they fit:** Their operational complexity is exactly the shape the platform handles. Their corporate partnerships generate evidence and reporting requirements that match the platform's existing primitives. The risk: they may have built or bought something already.
**What they would pay:** Enterprise tier at the upper end ($7,000+ per month) given the scale. MRV add-on optional.

### 6. Burnett Mary Regional Group (BMRG)

**Role:** Peak NRM body for the Burnett and Mary river catchments in Queensland. One of the six regional NRM organisations selected for the federal Carbon + Biodiversity Pilot under the $34M Agriculture Stewardship Package.
**Geography:** Burnett and Mary river catchments, Queensland.
**Project portfolio scale:** Carbon + Biodiversity Pilot is a market-based mechanism trial for biodiverse environmental plantings. Project counts at the pilot level are tens of properties, but BMRG also runs broader landholder enrolment programs.
**The right human:** [Contact role TBD via warm intro through NRM Regions Australia.] BMRG's CEO is the entry point; we should not approach until we have the NRM Regions Australia warm-intro standing. BMRG is one of 54 NRM bodies and approaching them direct without the peak-body context is procurement-noise.
**Opening hook:** The Carbon + Biodiversity Pilot's measurement and reporting requirements are demanding for a regional NRM body. The platform's operational sync layer keeps the existing pilot reporting templates intact while giving BMRG a member-and-events-and-impact spine that the spreadsheets cannot provide.
**Why they fit:** Pilot regional NRM body, federally-funded, already running a market-mechanism trial. Demonstrates the regional-NRM tier of the offer.
**What they would pay:** Enterprise tier at $5,000 per month. MRV add-on conditional on whether they enrol landholders in NRM market projects.

### 7. NAILSMA (North Australian Indigenous Land and Sea Management Alliance)

**Role:** Indigenous-led not-for-profit operating across north Australia. Recognised by government and industry on water policy, marine planning, carbon, Indigenous livelihoods, and Indigenous youth leadership. Has managed collaborative research into fire and carbon since 2008. ICIN member.
**Geography:** Northern Australia (NT, WA, QLD).
**Project portfolio scale:** Manages collaborative carbon-research projects with Indigenous land managers establishing fire and emissions abatement projects. Co-hosts the National Indigenous Carbon Forum (Darwin, February 2026, alongside the 8th Savanna Fire Forum).
**The right human:** [Contact role TBD via ICIN warm intro.] NAILSMA's leadership is the entry point but should be approached through ICIN rather than direct.
**Opening hook:** The 2026 NICF and Savanna Fire Forum identified concrete software gaps for Indigenous land managers running fire and carbon projects. The platform's MRV add-on is the conversation; the operational platform is secondary.
**Why they fit:** Mid-scale Indigenous aggregator with carbon track record going back to 2008. Pilot site for Indigenous-method MRV configurability.
**What they would pay:** Enterprise tier at $5,500 per month plus MRV add-on at $1,500 per month.

### 8. Indigenous Desert Alliance (IDA)

**Role:** Indigenous-controlled, member-based organisation coordinating over 60 desert ranger groups across WA, SA, and NT. Operates the Desert Nature Market initiative and runs the largest annual gathering of Indigenous rangers in Australia.
**Geography:** Australian deserts, primarily WA, SA, NT.
**Project portfolio scale:** 60+ ranger groups, hundreds of Indigenous rangers, dozens of member organisations. Carbon project pipeline emerging via the Desert Nature Market initiative and adjacent biodiversity-market work.
**The right human:** [Contact role TBD via ICIN or via Country Needs People warm intro.] Conference circuit (the IDA Conference) is a likely first-touch venue.
**Opening hook:** The Desert Nature Market initiative is positioning IDA members for emerging biodiversity markets. Existing tooling is configured for single-method savanna projects. Desert ecosystems require different evidence schemas. The platform's per-tenant configurability handles desert-specific impact metrics without forcing IDA into a savanna template.
**Why they fit:** Mid-scale Indigenous aggregator at the front edge of the biodiversity-market expansion. Strong governance, growing carbon and biodiversity ambition, software gap is wide.
**What they would pay:** Enterprise tier at $5,500 per month. MRV add-on conditional on member uptake.

### 9. Bush Heritage Australia

**Role:** Conservation NFP managing reserves and partnership areas across over 22.5 million hectares. Partners with Greening Australia and Carbon Positive Australia on biodiversity-and-carbon projects. Active in biodiversity certification under the Nature Repair Market.
**Geography:** National.
**Project portfolio scale:** Eurardy Reserve (mid-west WA, partnership with Carbon Positive Australia, ~90,000 tonnes carbon offset). Ediegarrup Reserve (south-west WA, 600 hectares biodiversity restoration with Greening Australia, 150 species native plantings). Sequesters more carbon than it emits across the portfolio.
**The right human:** Rachel Lowry (CEO, appointed 2024). She came in for transformation and has a brief that includes operational modernisation.
**Opening hook:** Bush Heritage is one of the few national NFPs running both biodiversity certification under the Nature Repair Market and a carbon project portfolio. The operational complexity of running two market-mechanism tracks alongside their reserve-management work is the platform's domain.
**Why they fit:** Mid-tier conservation buyer with carbon and biodiversity ambition, scale that justifies enterprise pricing, leadership transition that creates a procurement-review window.
**What they would pay:** Enterprise tier at $6,500 per month. MRV add-on at $1,500 per month for the Nature Repair Market biodiversity certification work.

---

## Tier 3: Watchlist (Trigger Conditions Required)

### 10. Australian Wildlife Conservancy (AWC)

**Role:** 31 sanctuaries and partnership sites, 6.5 million hectares under conservation, $100M fundraising drive (10-year plan), CEO Tim Allard.
**Trigger to move up:** AWC has built significant in-house systems and operates at a scale that may outgrow per-tenant pricing. Move to Tier 1 if (a) AWC announces an external partnership shift, (b) Tim Allard or a senior leader signals procurement review of operational tooling, or (c) the lighthouse deployment becomes a credible reference at conservation-NFP scale.

### 11. Kanyirninpa Jukurrpa (KJ)

**Role:** Martu organisation, three ranger teams across four communities, 65,000 km² of country. Strong cultural-knowledge integration with conservation work (Northern Quoll research with DBCA and UWA). Not an aggregator at the peak-body level; their federation shape is internal to the org.
**Trigger to move up:** Approach via ICIN warm-intro path only, after ICIN deal is closed. KJ is a single-org buyer rather than a peak body; per-tenant pricing applies. Move to Tier 2 if KJ signals interest in the platform via an ICIN reference deployment.

### 12. Carbon Market Institute (CMI)

**Role:** Peak industry body for climate change and business, representing carbon project developers, emissions-intensive industries, financiers, and market advisers. Hosts the Carbon Farming Industry Forum and various 2026 project showcase events.
**Trigger to move up:** CMI is a channel partner rather than a buyer in the same sense as the others. Move to a different relationship type (event sponsor, showcase presenter, or industry-forum speaker slot at the Carbon Farming Industry Forum 2026) once we have at least one Tier 1 deployment live and quotable.

---

## Approach Sequence

1. **Landcare Australia first.** Warm-intro path is already mapped via Kurt and the Co-Exist board. The Landcare hook is drafted (`landcare-hook.md`) and ready for Tate to relay when he chooses. Wait for response or 21 days, whichever lands first.
2. **NRM Regions Australia second** (approximately three weeks after Landcare). Approach during the May 2026 CEO transition window. Marnie Lassen is incoming and runs discovery conversations on landing. Frame as "what regional NRM bodies are asking for in the carbon and environmental markets discussion group."
3. **ICIN third** (approximately two weeks after NRM Regions). Approach with the substrate-disclosure framing intact. Cultural and governance diligence is the highest bar; we should be ready for a 60 to 90 day discovery cycle and treat this as a credentialing conversation as much as a sales conversation.
4. **Aboriginal Carbon Foundation fourth** (concurrent with or after ICIN). Direct approach to Rowan Foley is plausible but warmer if it follows the ICIN conversation.
5. **Tier 2 in parallel after Tier 1 signal.** If Landcare or NRM Regions signals interest, the Tier 2 list opens for parallel approach via the warm-intro paths the Tier 1 conversation generates.

Conversion looks different at each tier:

- **Landcare Australia:** warm-intro accepted, exploratory call within 30 days, tailored deck inside 48 hours of the call, scoped pilot for one network or for Junior Landcare within 90 days.
- **NRM Regions Australia:** showcase or briefing slot in the carbon and environmental markets discussion group within 90 days, paid pilot with one of the six Carbon + Biodiversity Pilot bodies within 180 days.
- **ICIN:** 60 to 90 day discovery cycle, board-level briefing, member referral to one or two ICIN organisations for paid pilot within 180 days.
- **AbCF:** direct discovery call, scoped Cultural Fire Credit configuration within 60 days, paid build inside 90 days.

---

## Risks

**Closes the door on Tier 1:**

- Landcare Australia rejects the substrate disclosure on cultural or procurement grounds. Read: peak-body resistance to AI-LLC vendors is real, the Tier 2 and Tier 3 conversations get harder, and the wedge contracts to direct project-developer SaaS where the buyer has more autonomy.
- AgriProve announces a peak-body or community-aggregator product. Their commercial structure shifts to capture sub-commercial, the wedge narrows, and the offer has to differentiate on configurability and IP retention rather than on category absence.
- CER changes the methods in a way that obsoletes the integration assumptions (for example, a rule that requires direct registry integration we cannot build). Mitigate by tracking the CER method pipeline quarterly per the Apr 22 2026 NRM research.

**Closes the door on Tier 2:**

- Greening Australia announces an in-house platform (likely if they have already built one). Removes the largest in-tier deal but does not affect the regional-NRM or Indigenous-aggregator tracks.
- Bush Heritage Australia signals a different procurement direction under Rachel Lowry's transformation brief. Read as a signal that conservation-NFP procurement is institutionally cautious, and recalibrate the substrate-disclosure framing.

**Closes the door on Tier 3:**

- AWC closes a strategic partnership with a US or UK MRV platform. Validates the global observation-layer-only positioning of those incumbents and means the in-house build wins at AWC's scale; does not affect the sub-commercial wedge.

---

## What I Will Not Do

I will not pitch this to an org whose shape does not map. The substantive-applicability test gates every conversation. If a regional NRM body has 12 staff and 80 landholders enrolled, the platform tier does not apply; the conversation pivots to a custom-build quote or a referral. I will not promise per-tenant configuration that is actually a rewrite. I will not white-label the lighthouse charity's brand or content. I will not approach any of the orgs above without Tate's explicit per-message go-ahead per the no-unilateral-client-contact rule.

---

## Cross-References

- `~/ecodiaos/drafts/conservation-platform-rebrand/positioning-v1.md` - the underlying positioning these targets sit inside.
- `~/ecodiaos/drafts/conservation-platform-rebrand/landcare-hook.md` - the drafted Tier 1 #1 opening.
- `~/ecodiaos/drafts/conservation-platform-rebrand/federation-pitch-deck-v1.html` - the deck the warm-intro conversations pivot to.
- Neo4j Research: "Australian Nature Repair Market - State of Play + MRV Software Gap (Apr 22 2026)".
- Neo4j Research: "Australian Nature Repair Market - MRV software wedge analysis (Apr 27 2026)".
- Neo4j Research: "Australian carbon MRV market 2026 - peak-body dMRV gap (Apr 27 2026)".
- `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md` - the rule every approach above obeys.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the test that gates every tier conversation.
