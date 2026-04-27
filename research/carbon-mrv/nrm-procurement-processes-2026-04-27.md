[INTERNAL]

# How Australian NRM Bodies Actually Buy Software and MRV Services

Research note for the carbon-MRV peak-body GTM bundle. Generated 2026-04-27, fork fork_moh82iyh_be02b4. Purpose: ground the federation deck v2, MRV add-on technical spec v1, and peak-body target list v1 in a realistic understanding of how the 56 NRM regional bodies (the official spatial count; the peak body operating count is 54) procure software and verification services. This determines whether our sales motion should be direct-to-region, tendered, federated through NRM Regions Australia, or sub-contracted under a prime such as a Regional Delivery Partner (RDP).

---

## 1. The 56 NRM regions: governance and funding structure

There are 56 spatially defined NRM regions across Australia, set under bilateral agreements signed between the Commonwealth and each State/Territory between 2001 and 2004. The peak body NRM Regions Australia operationally counts 54 regional NRM organisations because some adjacent regions share a single delivery body. The institutional form differs by state: a Tasmanian region (e.g. NRM South) is an incorporated association established under the Tasmanian Natural Resource Management Act 2002; Queensland regions are companies limited by guarantee with independent boards; NSW regions are delivered through Local Land Services, a NSW Government statutory authority; Victorian regions are the ten Catchment Management Authorities (CMAs), which are state government authorities established under the Catchment and Land Protection Act 1994.

Funding mix is broadly tri-source: federal Natural Heritage Trust funding (the dominant single channel), state government funding (variable, often via service-delivery agreements with the relevant department), and own-source revenue (philanthropic grants, corporate partnerships, fee-for-service work, levies in some states). Per NRM Regions Australia, regional bodies "leverage investment from a range of sources, at least matching every dollar of Australian Government funds", which suggests roughly 50 per cent federal / 50 per cent everything else as a sector average. Boards are typically community-skilled and independent.

Source: NRM Regions Australia, "Our role" and "Regions" pages (https://nrmregionsaustralia.com.au/about-us/our-role/, https://nrmregionsaustralia.com.au/regions/); ANU Press, "NRM Governance in Australia: a complex federal system" (https://press-files.anu.edu.au/downloads/press/p52401/html/ch07s05.html); NRM Regions Queensland (https://www.nrmrq.org.au/); Vic Catchments (https://viccatchments.com.au/about-us/).

## 2. Procurement framework

Three layers stack on top of each NRM body's purchasing decision:

**Commonwealth Procurement Rules (CPRs), 1 July 2024 edition.** Apply directly to non-corporate Commonwealth entities (DCCEEW, NIAA, DAFF) and bind any Commonwealth grant agreement that flows on to a regional body. Key thresholds: AUD $80,000 for non-corporate entities (the trigger above which an open or limited tender is required absent an exemption), AUD $400,000 for prescribed corporate Commonwealth entities (excluding construction), AUD $7.5m for construction. The SME exemption was lifted from $200,000 to $500,000 from July 2024, meaning Commonwealth buyers can purchase directly from an SME up to half a million dollars without running an open competitive process. The economic benefit assessment threshold dropped from $4m to $1m. Commonwealth SME procurement targets rose to 25 per cent of all spend below $1bn and 40 per cent of all spend below $20m. (Department of Finance, https://www.finance.gov.au/government/procurement/commonwealth-procurement-rules; AGS Legal Update 323, https://www.ags.gov.au/publications/legal-update/no323.)

**State procurement frameworks.** Bind regions that are state agencies (NSW LLS, Victorian CMAs) or that contract through state procurement panels. NSW: the ICT Purchasing Framework is mandated by Procurement Board Direction PBD-2025-03; Core& contracting framework covers low-risk ICT up to AUD $1m, MICTA/ICTA covers above $1m or high-risk. (info.buy.nsw, https://www.info.buy.nsw.gov.au/resources/ICT-Purchasing-Framework.) Victoria: CMAs run tenders through Buying for Victoria, apply the Social Procurement Framework, and use state-government Supplier Code of Conduct. (Corangamite CMA Procurement Strategy 2021-2024; https://ccma.vic.gov.au/procurement/.)

**NRM body internal policies.** Most bodies publish a procurement policy that defaults to three written quotes for purchases above roughly AUD $5,000 to $10,000, a competitive process (RFP or tender via an e-tendering portal) above roughly AUD $50,000 to $100,000 depending on the body, and a board-approval requirement above AUD $250,000 to $500,000. Below the lowest threshold the body can buy directly from a single supplier on receipt of a single quote. Goulburn Broken CMA, Corangamite CMA, and most company-limited-by-guarantee Queensland bodies follow approximately this pattern.

Practical implication for our pricing: a sub-AUD $80,000 annual licence to a single region can typically be procured as a direct purchase or limited single-source quote. A consortium-scale deployment (e.g. 12 Queensland regions on a single contract) almost certainly triggers an open or select tender unless it is structured as a sub-contract under an existing prime contract such as an RDP service agreement.

## 3. Federal funding flows

**Natural Heritage Trust (NHT) Phase 4.** AUD $1.1bn over five years to 30 June 2028, announced in the October 2022 and May 2023 Budgets. Replaced the Regional Land Partnerships (RLP) program (AUD $450m, 2018-19 to 2022-23) which had contracted 50 service providers across 54 management units to deliver 225 projects. Phase 4 funding flows primarily through the Panel of Regional Delivery Partners (RDPs), a Deed of Standing Offer available to all Australian Government agencies until 30 June 2028. RDPs are the contracting counterparty; many are themselves the regional NRM bodies (Local Land Services, Cape York NRM, Rangelands NRM, Terrain NRM, etc.). Software and MRV expenses are eligible to the extent they support the RDP's project deliverables. (DCCEEW, https://www.dcceew.gov.au/environment/land/natural-heritage-trust/current-phase-natural-heritage-trust; DCCEEW Panel of Regional Delivery Partners, https://www.dcceew.gov.au/environment/land/regional-delivery-partners.)

**Indigenous Protected Areas (IPA) program.** Continued funding of AUD $162.8m for existing IPA projects announced 10 July 2024, plus AUD $14.68m for twelve new IPA projects, plus the AUD $250m Australian Bushland Program announced March 2025 (over five years from July 2025) that will partly grow the IPA estate. IPAs are funded via multi-year management-plan agreements between NIAA (post-2019 transfer) and Indigenous land-owning entities. Software and MRV expenses are eligible where they support delivery of the management plan, which often includes biodiversity monitoring and ranger reporting. (DCCEEW IPA grants page; NIAA IPA program page, https://www.niaa.gov.au/our-work/environment-and-land/indigenous-protected-areas-ipa.)

**Future Drought Fund (FDF).** AUD $20m over three years from 2025-26 for the Drought Resilience Innovation Challenges Pilot, plus the NRM Drought Resilience Program Grants stream (multiple rounds since 2020). Software for natural-capital monitoring and decision support is explicitly within scope of the innovation pilot. (DAFF, https://www.agriculture.gov.au/agriculture-land/farm-food-drought/drought/future-drought-fund.)

**Bilateral state partnerships.** AUD $20m in the 2023-24 Federal Budget for bilateral partnership agreements between the Commonwealth and each State/Territory, layered on top of the NHT and feeding state-administered programs that often pass through to regional bodies.

**Caring for Country / Working on Country / ranger programs.** Now substantially folded into NIAA's Indigenous-specific grant streams and the IPA program; "Caring for Country" today refers more often to NSW DPIE's Aboriginal Outcomes Strategy 2024-33 than to a discrete federal program. Software eligibility is generally within scope provided it supports plan delivery.

In all four federal channels the operative test is not whether software is allowable in the abstract; it is whether the cost is reasonable, attributable to the funded outcome, and within the budget headings the recipient committed to in their funding agreement. Public itemised data on what proportion of NHT or IPA spend goes on software is not published. Inference from RLP service agreements (publicly available via ANAO) is that information-systems and reporting line items typically run at low single-digit per cent of total project cost, with the largest absolute spend on field labour, on-ground works, and travel.

## 4. Existing software vendors serving NRM bodies

**MERIT (Monitoring, Evaluation, Reporting and Improvement Tool).** Mandatory for all DCCEEW-funded NRM grant recipients. Built by the Atlas of Living Australia (ALA), CSIRO-hosted, free at point of use to grant recipients. Provides project setup, MERI plan submission, milestone reporting, financial acquittal, and aggregated public dashboards. Recipients log activities, sites, monitoring data, and outputs. MERIT is a federal-funded common asset rather than a procured product line item. (DCCEEW MERIT, https://www.dcceew.gov.au/environment/land/landcare/my-project/monitoring-reporting/merit; FieldCapture/MERIT, https://fieldcapture.ala.org.au/.)

**FieldCapture and BioCollect.** Both built and operated by ALA. FieldCapture is the underlying engine that powers MERIT; BioCollect is the project-and-survey tool used by ecologists and citizen scientists for ad-hoc biodiversity monitoring. Free at point of use. Many NRM bodies use BioCollect for non-MERIT-mandated monitoring. (https://www.ala.org.au/biocollect/.)

**CSIRO products.** Land Account, ALA itself, plus various spatial and modelling tools. Provided as public-good infrastructure, generally not procured at the regional level.

**Commercial GIS.** ESRI ArcGIS dominates among regional bodies that have a dedicated GIS officer; QGIS is common where budget is tighter or staff are open-source friendly. ESRI is typically procured under the relevant state government enterprise agreement (NSW, VIC, QLD all have whole-of-government ESRI deals) and the regional body either consumes a sub-licence at no incremental cost or pays a relatively small annual fee. New direct ESRI sales to regional bodies are uncommon.

**Microsoft 365 / SharePoint.** Universal. Procured through state EA in some cases, direct via Microsoft partner channel in others. Annual cost per body is typically in the AUD $20k to $80k range depending on staff count.

**CRM and project management.** Mixed. Some bodies use Accelo, others Salesforce, others HubSpot, others bespoke Access databases. No sector-standard CRM. Most are direct-procured at SME thresholds under three-quote rules.

**Carbon and MRV-specific tools.** Largely absent at the regional-body level today. Where regions are involved in carbon-method projects (e.g. via partnerships with carbon project developers), the MRV stack is procured by the project developer or aggregator, rarely by the NRM body itself. CER's ACCU Scheme submission system (ERIC and the project register) is used directly by project proponents; NRM bodies are not typically the proponent.

The headline point: today's software footprint at a regional NRM body is dominated by free federal infrastructure (MERIT, BioCollect, ALA), standard commercial enterprise software (ESRI, Microsoft), and a long tail of small SME purchases in the AUD $5k to $80k band. There is no incumbent dMRV vendor.

## 5. State-level structural differences

**NSW.** Local Land Services (LLS) is a NSW Government statutory authority covering 11 regions. Procurement is governed by the NSW Government Procurement Policy Framework and the ICT Purchasing Framework (PBD-2025-03 mandated). Software vendors must typically prequalify on the ICT Services Scheme for sales above a few hundred thousand dollars. LLS is the NSW Regional Delivery Partner for NHT.

**VIC.** Ten Catchment Management Authorities (CMAs) plus Melbourne Water as the metropolitan equivalent. CMAs are state agencies, procurement runs through Buying for Victoria with mandatory Social Procurement Framework. Vendor onboarding similar to NSW.

**QLD.** 12 regional NRM bodies, all companies limited by guarantee (or similar private not-for-profit forms), employing approximately 350 staff across 28 sites. Federated under NRM Regions Queensland (NRMRQ), itself a company limited by guarantee. Each body sets its own procurement policy. Less formal than NSW/VIC; faster purchasing decisions; the bottleneck is board approval at the high end and CEO authority at the low end.

**WA.** Seven regional NRM groups federated under NRMWA (the WA peak body), plus the rangelands area covered by Rangelands NRM. Mostly not-for-profit incorporated associations or companies limited by guarantee. Procurement is internal-policy driven, similar to QLD.

**SA.** Regional Landscape Boards established under the Landscape South Australia Act 2019 (replacing the previous NRM Boards), part-state-agency, part-independent, funded by a regional landscape levy plus state and federal grants. Procurement runs under SA Government policy when state-funded.

**TAS.** Three bodies (NRM North, NRM South, Cradle Coast NRM), incorporated associations under the Tasmanian Natural Resource Management Act 2002. Internal procurement policies, modest budgets relative to mainland regions.

**NT.** Territory NRM is a single non-government organisation covering the whole NT. Internal-policy procurement.

The structural tell: states with publicly run regional bodies (NSW, VIC) have heavier procurement compliance and a longer sales cycle but a higher single-deal ceiling. States with non-government bodies (QLD, WA, TAS, NT, and the SA Landscape Boards in their non-state capacity) have lighter procurement compliance and shorter sales cycles, with most deals settled at the CEO or board level. SA sits in between.

## 6. NRM Regions Australia: buyer or coordinator

NRM Regions Australia is the national peak body for the 54 regional NRM organisations. It is led by CEO Dr Kate Andrews and governed by a board of nine (one director from each of the eight jurisdictions plus an independent chair). Public-domain detail on its operating revenue and staff count for FY2023-24 is thin in the indexed search results; the FY2023-24 annual report PDF is published at https://nrmregionsaustralia.com.au/wp-content/uploads/2024/12/NRM-RA-Annual-Report-2024.pdf and would carry the figures. Inference from the size of its public-facing operation, a small permanent staff (likely fewer than ten full-time equivalents) and an annual operating budget likely in the low millions of AUD, primarily from member contributions and Commonwealth grants for sector-coordination work.

For our purposes the operative point is that NRM Regions Australia is principally a coordinating body. It does not procure software on behalf of its members. It influences sector-wide procurement only through advocacy, common-platform proposals, and informal coordination at the CEO Forum. A federation deal that aspires to "sell once to NRM Regions Australia and roll out to all 54 members" misreads the institutional mechanic. The peak body can endorse, convene, and de-risk; it cannot purchase.

The same is true at state level: NRM Regions Queensland and NRMWA both convene and advocate without aggregating procurement. The exception is the SA Landscape Boards, where the SA Department of Environment and Water can in principle procure a state-wide common asset on behalf of all boards.

## 7. Indigenous land-management procurement

When an NRM body engages with an IPA, ranger group, or other Indigenous-owned land-management entity, who buys the dMRV layer? Three patterns observable in the public record:

1. **Indigenous-owned ranger entity is the funded counterparty.** Most IPA management-plan funding flows directly from NIAA to the Indigenous-owned entity (a Prescribed Body Corporate, ranger company, or PBC-controlled trust). The ranger entity procures monitoring tools as a line item in its plan budget. Procurement decision sits with the ranger entity's CEO and board, with internal-policy thresholds typically lighter than NRM body norms. NRM body involvement is partner-or-supporter rather than purchaser.

2. **NRM body is the prime, ranger group sub-contracted.** In some Caring for Country and NHT-flow projects (more common pre-2019, less common post the IPA transfer to NIAA), the NRM body holds the head agreement with the Commonwealth and the Indigenous land-management group is sub-contracted. In these, the NRM body procures the dMRV layer.

3. **Carbon project developer is the buyer.** Where the work is a savanna burning ACCU project or a vegetation method ACCU project, the carbon project developer or aggregator (often an Indigenous-owned aggregator such as ALFA or Aboriginal Carbon Foundation; or a partnered commercial aggregator) buys the MRV stack and the ranger group consumes the data-collection apps. ICIN (Indigenous Carbon Industry Network) is the peak body for this segment, with 23 Indigenous land and sea management organisation members, generating approximately 1.2 million ACCUs per year and approximately AUD $59m annually across compliance and voluntary markets. (ICIN, https://www.icin.org.au/.)

For our GTM the practical implication is that the buyer for Indigenous land-management dMRV is split across three counterparties depending on the funding source: NIAA-funded IPA work goes to the ranger entity, NHT-funded work via an NRM-body prime goes to the NRM body, and ACCU-method work goes to the carbon project developer. ICIN can endorse and de-risk across all three but does not purchase on behalf of members.

## 8. Synthesis: the right sales motion

Five bullets on how to actually sell against this market. Each bullet weights effort against expected revenue and time-to-close.

- **Pursue federation through NRM Regions Australia for endorsement, but do not expect aggregated purchasing.** A peak-body endorsement de-risks regional sales by an order of magnitude. Treat it as a marketing channel rather than a purchasing channel. Closing the peak body relationship costs 6 to 12 months of relationship work and yields zero direct revenue. The ROI is downstream regional close-rate and average-deal-size lift.

- **Run direct sales to non-government regional bodies (QLD, WA, TAS, NT, SA Landscape Boards in their NGO capacity) at sub-Commonwealth-procurement-threshold pricing.** Annual licence priced under AUD $80,000 per region per year fits inside SME-direct procurement and the body's own three-quote threshold. Sales cycle 3 to 6 months. Buyer is the CEO or operations director. This is the highest-velocity channel.

- **For NSW and Victoria, sell as an SME on the relevant ICT panel and target sub-AUD $1m engagements.** Prequalify on NSW ICT Services Scheme and Buying for Victoria. Sales cycle 9 to 18 months. Buyer is the LLS regional manager or CMA CEO with state-procurement-officer sign-off. Higher floor on deal size, longer cycle, more compliance overhead. Worth it if the deal value is over AUD $250,000 per year per body.

- **Sub-contract under a Regional Delivery Partner (RDP) for NHT-funded delivery.** RDPs are the contracting counterparty for the AUD $1.1bn NHT Phase 4 spend. A dMRV product can be embedded into an RDP's project budget as an information-systems line item, billed to the prime. Sales cycle is the RDP's project-design cycle, which is annual or longer. Margin is split with the prime. This is the best path for regions that are themselves RDPs and want to pull a vendor onto multiple of their NHT projects without running a separate procurement.

- **Treat ICIN as the channel for Indigenous carbon-method projects, and target the carbon project developer or aggregator as the actual buyer.** ICIN endorsement opens conversations with members and aggregators. The purchase order comes from the carbon project developer, who is selling AUD-millions of ACCUs annually and has procurement appetite for MRV that protects its revenue base. Higher margin, faster decisions than NRM body sales, but smaller total addressable market.

Where the synthesis tilts inferential rather than evidential: the proportion of NHT and IPA spend that goes to software (Section 3), the typical internal NRM body procurement thresholds (Section 2), and the operating revenue / staff count of NRM Regions Australia (Section 6) are inferred from published policies and adjacent data points. These would be tightened by reading the FY2023-24 annual reports of two or three regional bodies and NRM Regions Australia, plus a sample of RLP service agreements which are public via ANAO.

---

Sources cited inline above. Primary references:

- Department of Finance, Commonwealth Procurement Rules 1 July 2024: https://www.finance.gov.au/government/procurement/commonwealth-procurement-rules
- DCCEEW, Natural Heritage Trust current phase: https://www.dcceew.gov.au/environment/land/natural-heritage-trust/current-phase-natural-heritage-trust
- DCCEEW, Panel of Regional Delivery Partners: https://www.dcceew.gov.au/environment/land/regional-delivery-partners
- DCCEEW, MERIT: https://www.dcceew.gov.au/environment/land/landcare/my-project/monitoring-reporting/merit
- ANAO, Regional Land Partnerships performance audits: https://www.anao.gov.au/work/performance-audit/regional-land-partnerships
- NRM Regions Australia: https://nrmregionsaustralia.com.au/
- NRM Regions Queensland: https://www.nrmrq.org.au/
- NIAA, Indigenous Protected Areas: https://www.niaa.gov.au/our-work/environment-and-land/indigenous-protected-areas-ipa
- Indigenous Carbon Industry Network: https://www.icin.org.au/
- Clean Energy Regulator, ACCU Scheme: https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme
- info.buy.nsw, ICT Purchasing Framework: https://www.info.buy.nsw.gov.au/resources/ICT-Purchasing-Framework
- DAFF, Future Drought Fund: https://www.agriculture.gov.au/agriculture-land/farm-food-drought/drought/future-drought-fund
