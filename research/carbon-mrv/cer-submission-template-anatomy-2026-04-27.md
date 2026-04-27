# CER ACCU submission anatomy: end-to-end paperwork

Research note for the carbon MRV thread (Neo4j Research 3079). Author: EcodiaOS, fork fork_moh61xno_d7dd1a. Date: 27 Apr 2026.

## Why this matters for Ecodia

Our pricing deck (federation pitch v2) commits to a software product that ingests project data and emits "CER submission templates pre-wired to soil-method CFI-MER-2018 and other ERF methodologies." To make that promise operational, we need a clear specification of what a CER submission package actually contains end-to-end. This note walks the full lifecycle: project registration through method declaration, monitoring, audit, and ACCU issuance, naming the documents, fields, attachments, and review timelines at each step.

Three frame conditions to keep in mind:

1. The Clean Energy Regulator (CER) administers the Australian Carbon Credit Unit (ACCU) Scheme under the Carbon Credits (Carbon Farming Initiative) Act 2011 (CFI Act) and the Carbon Credits (Carbon Farming Initiative) Rule 2015 (CFI Rule). The Act and Rule define the baseline information requirements; each method (Determination) layers method-specific requirements on top [1][2].
2. CER does not publish a single PDF "Project Plan template." Submission is increasingly via the CER's digital portal (the Plan your project portal and the Client Portal). What we generate has to map cleanly onto the portal's expected fields and attachment slots.
3. Audit is not a one-off gate at submission. It is structured into the project lifecycle as a series of scheduled audits over the crediting period (usually 7 to 25 years), with the first audit attached to the first offsets report.

## Stage 1: Project registration

### Form: ACCU Scheme Project Application

Submitted via the Clean Energy Regulator's Plan your project / Client Portal. The application is web-based, signed by an authorised signatory who makes legally binding declarations on the project proponent's fitness, legal authority, and accuracy of information [3].

### Core fields and attachments

- **Project proponent details**. Legal entity name, ABN/ACN, registered address, contact details. Fit-and-proper-person test applies.
- **Project name and description**. Plain English summary of the proposed activity, project area, and expected abatement pathway.
- **Method selected**. The specific Determination under which the project will be run (for example, Carbon Credits (Carbon Farming Initiative) Savanna Fire Management - Emissions Avoidance and Sequestration Determination 2018, or one of the soil carbon, vegetation, or industrial methods).
- **Project area**. Spatial definition of the project boundary. Mapped polygons in a CER-accepted format. For sequestration methods, must include Carbon Estimation Areas (CEAs) defined within the project area where eligible activities are carried out and ACCUs are expected to be earned [4].
- **Crediting period**. 7, 25, or 100 years depending on method.
- **Forward Abatement Estimate (FAE)**. Best estimate of total ACCUs across the crediting period. Used to determine the audit schedule. CER explicitly notes there is no single right way to calculate the FAE, but the proponent is on the hook for it [5].
- **Eligible Interest Holder Consent forms**. One signed consent per holder of an eligible interest in the land. Eligible interest-holders include any person or organisation with a legal interest in the land. Without complete consents, the project is conditionally registered and cannot earn ACCUs until the conditions are cleared, with a deadline at the end of the first reporting period [6][7].
- **Legal right evidence**. Title deeds, leases, native title agreements, ILUAs, or other instruments showing the proponent has legal right to carry out the project at every site listed.
- **Regulatory approvals**. Copies of any required state or local approvals, or a declaration that they will be obtained.
- **Newness and additionality declarations**. Confirmation that the project meets the newness rule (project not commenced) and any method-specific regulatory additionality requirements [8].
- **Aggregation declaration** (if applicable). Where the proponent is registering a project that aggregates multiple sites or sub-projects, the aggregation structure and the contractual basis for it.
- **Authorised signatory declaration**. Final attestation block.

### Review and timeline

CER reviews the application; statutory clock varies. Conditional registration is the norm where consents or approvals are still being collected. Full registration is granted when all conditions are cleared.

### What our system has to produce

A complete Project Application bundle: a generated PDF cover plus a structured payload that maps to the portal's field schema, plus attachments (consent forms, legal-right evidence, mapped polygons in GeoJSON or shapefile, FAE workings). Bi-temporal tracking matters here: each consent has both a signed-on date and a system-recorded date, and any field changes need to remain auditable for the life of the project.

## Stage 2: Method declaration and eligibility evidence

The method is named in Stage 1, but the eligibility evidence is method-specific and continues into the operational phase. Examples:

### Savanna fire management (2018 method, transitioning to 2026 method)

- **Eligible vegetation type evidence**. Project area must contain eligible savanna vegetation types in high or low rainfall zones in northern Australia [9][10].
- **Baseline emissions reference period**. Established under the method.
- **Tooling**. Use of the Savanna Burning Abatement Tool (SavBAT, currently v3) for the 2018 method, or the Savanna Carbon Accounting Model (SavCAM) for 2026 method projects [11][12].
- **Annual fire scar maps**. Required for each calendar year, identifying burnt and unburnt mapping units.
- **Two-toolbox evidence** (where Indigenous fire management practices contribute). Documentation of traditional knowledge inputs alongside scientific monitoring.

### Soil carbon (Estimating Soil Organic Carbon Sequestration using Measurement and Models, CFI-MER-2018)

- **Soil sampling plan**. Pre-baseline and on-going sampling stratification.
- **Lab analysis evidence**. NATA-accredited lab results for each soil sample.
- **Land management activity evidence**. Documentation of new management activities (cover cropping, rotation changes, biochar, compost application, etc.).

### Vegetation methods (e.g., Plantings, Avoided Clearing, HIR)

- **Stratification of CEAs**. Definitions and maps.
- **Forest cover and growth modelling evidence**. FullCAM or other CER-approved tool outputs.
- **Permanence elections**. 25-year or 100-year permanence period and the carbon maintenance obligation that follows.

### What our system has to produce

A method-aware document set per project. The platform must know which method the project sits under and emit the right evidentiary attachments automatically. This is the core of the dMRV value proposition: the tooling, sampling, and mapping outputs are continuously generated from the operational data layer rather than assembled from spreadsheets at submission time.

## Stage 3: Offsets reports (the operational reporting cycle)

### Form: Project offsets report

The recurring reporting deliverable. Submitted within 6 months of the end of each reporting period. Reporting frequency depends on net abatement [13]:

- At least every 12 months if net abatement is 2,000 tonnes CO2-e or more per year (most projects),
- Every 6 months minimum cadence available, more frequent permitted up to monthly,
- Up to multi-year reporting periods for some methods (savanna emissions avoidance allows reports up to once every 2 years; sequestration methods allow up to 5 years) [14].

### Content of an offsets report

- **Reporting period**. Start and end dates.
- **Project activities undertaken**. Summary of operational activity in the period.
- **Net abatement claim**. Total tonnes CO2-e abated or sequestered, with method-specific calculation outputs attached.
- **Method-specific tool outputs**. SavBAT/SavCAM report for savanna; FullCAM output for vegetation; soil model output and lab certificates for soil carbon.
- **Project area and CEA changes**. Any variations to the registered project boundary or CEAs.
- **Compliance with method requirements**. Attestation that all method-specific operational requirements (e.g., burn timing, sampling cadence, baseline preservation) have been met.
- **Supporting evidence**. Field data, photos, GPS-tagged records, contractor reports, ranger logs, lab certificates, SavBAT inputs and outputs.
- **Authorised signatory declaration**.

### What our system has to produce

A reporting-period bundle: numerical claim, narrative summary, attached method-tool outputs, evidence index. Crucially, the system must trace every number in the claim back to the underlying field record (GPS-tagged ranger entries, sample records, fire scar tiles). Without traceability, the audit at Stage 4 fails.

## Stage 4: Audit

### Audit cadence

Most projects: minimum of 3 scheduled audits across the 7-to-25-year crediting period. The number is determined by the Audit Thresholds Instrument (currently the Carbon Credits (Carbon Farming Initiative) (Audit Thresholds) Instrument 2025) and depends on the project's annual average abatement [15][16].

- **Initial audit**. Submitted with the first offsets report. Covers a minimum 6-month period and includes review of project registration, the FAE, the first offsets report (including accuracy of measured abatement), and all matters relating to project establishment and operation [17].
- **Subsequent scheduled audits**. Set by the audit schedule. Cover at minimum a 12-month reporting period and aim to provide reasonable assurance that the project remains in compliance and that abatement claimed is accurate.
- **Triggered audits**. CER may require additional audits at any time based on risk indicators.

### Auditor requirements

All ACCU Scheme project audits must be undertaken by a registered category 2 greenhouse and energy auditor, generally on-site, at the proponent's expense [18].

### Audit report content

- Auditor identification and registration details.
- Scope and period covered.
- Reasonable assurance opinion (or qualified opinion) on whether project activities and reported abatement comply with the method, the CFI Act, the CFI Rule, and the project's registration.
- Findings, exceptions, and corrections.
- Sign-off by the registered auditor.

### What our system has to produce

The auditor's job is to walk the data trail from operational records to the abatement number on the offsets report. Our platform's value here is making that walk fast and unambiguous: signed audit-trail records, immutable evidence storage, version history for every CEA change, time-stamped sampling records, and the ability to export an audit pack in a format the auditor can ingest. A good test: a registered auditor should be able to complete a project audit using only the platform export, with no need to chase the proponent for missing records.

## Stage 5: ACCU issuance

### Form: Certificate of Entitlement (COE) application

Web-based form. Submitted alongside the offsets report and (where required) the audit report. Information is submitted in three parts: COE application, project offsets report with supporting evidence, and audit report when required [19][20].

### COE application fields

- **Project identifier**.
- **Reporting period**.
- **Number of ACCUs claimed**.
- **Account into which ACCUs should be issued** (Australian National Registry of Emissions Units (ANREU) account).
- **Declarations**. Including newness, additionality, ongoing legal right, and continued compliance.

### Supporting evidence

- The project offsets report (Stage 3) in full.
- The audit report (Stage 4) where required.
- Method-specific calculation outputs and supporting records.
- Where applicable, evidence supporting changes to the project (CEA changes, area variations, method version updates).

### Review and timeline

CER reviews the COE application. ACCUs are not issued until the audit (where required) is provided and accepted. Once accepted, ACCUs are issued into the ANREU account and become tradeable [21].

### What our system has to produce

The complete issuance package: COE application payload (mapped to portal fields), full offsets report bundle, audit report attachment slot, evidence index, and a one-click export-to-portal flow. For aggregator clients (peak bodies running multiple sub-projects), the system needs to manage multiple parallel COE submissions on a shared cadence.

## What our system has to produce: end-to-end mapping

Pulled together, the dMRV platform must emit the following artifacts at the right moments in the lifecycle:

| Stage | Artifact | Frequency | System feature required |
|-------|----------|-----------|------------------------|
| Registration | Project application bundle | Once | Polygon mapping, FAE workings, consent management, legal-right evidence ingestion |
| Method declaration | Method-specific eligibility evidence | Once and ongoing | Method-aware schema, eligibility checks |
| Offsets report | Reporting-period bundle | Annually (or per method cadence) | Method-tool integration (SavBAT/SavCAM, FullCAM, soil models), evidence trail with bi-temporal audit |
| Audit | Audit pack export | At scheduled audits and on initial offsets report | Auditor-facing read-only export, immutable record store, version history per CEA |
| ACCU issuance | COE application + bundled report + audit | Per reporting period | Portal-shaped payload, ANREU account integration, multi-project orchestration for aggregators |

Three design choices follow directly from this mapping:

1. **Bi-temporal audit trail is non-negotiable**. Every record has an event-occurred-at timestamp and a system-recorded-at timestamp. Edits are versioned, never destructive. Auditors can ask for any historical state of any field.
2. **Method-aware document generation is a first-class capability**. The platform's data model must understand the active method on each project and generate the right tool inputs and the right submission templates without manual configuration per project. Treating it as an afterthought collapses the entire margin advantage.
3. **Aggregator orchestration sits on top**. Peak bodies running 5 to 50 sub-projects need a multi-project view that batches submission cadences, surfaces missing evidence early, and exports per-project bundles in parallel.

## Open questions to resolve directly with CER

The CER does not publish a downloadable "Project Plan template" PDF the way some voluntary registries do. The portal field structure is the source of truth. Three items to confirm with CER directly when an engagement is committed:

1. **Exact COE application field schema** for the active method versions. Latest portal field list, ideally as a structured export.
2. **Accepted attachment formats and size limits** for spatial data, audit reports, and method-tool outputs.
3. **Aggregator-specific portal flows**. Whether multi-project proponents (ALFA NT, KLC, AbCF) have a different submission flow or shared identifiers across sub-projects.

These are not publicly available in the form needed for direct system specification. Ask CER directly via the integration team.

## Sources

1. [Clean Energy Regulator: ACCU Scheme home](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme)
2. [DCCEEW: Australian Carbon Credit Unit (ACCU) Scheme](https://www.dcceew.gov.au/climate-change/emissions-reduction/accu-scheme)
3. [CER: Apply to participate in the ACCU Scheme](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate/apply-to-participate)
4. [CER: Understanding Carbon Estimation Areas (factsheet)](https://cer.gov.au/document/understanding-carbon-estimation-areas)
5. [CER: Forward abatement estimates](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate/apply-to-participate/forward-abatement-estimates)
6. [CER: Eligible interest-holder consent](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate/apply-to-participate/eligible-interest-holder-consent)
7. [CER: Legal right and native title](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate-accu-scheme/plan-your-project/legal-right-and-native-title)
8. [CER: Newness, regulatory additionality and government program requirements](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate/apply-to-participate/newness-regulatory-additionality-and-government-program-requirements)
9. [DCCEEW: Savanna fire management - emissions avoidance and sequestration 2018 method](https://www.dcceew.gov.au/climate-change/emissions-reduction/accu-scheme/methods/savanna-fire-management-sequestration-and-emissions-avoidance)
10. [DCCEEW: 2026 Savanna fire management methods](https://www.dcceew.gov.au/climate-change/emissions-reduction/accu-scheme/methods/savanna-fire-management-2026)
11. [SavBAT: Savanna Burning Abatement Tool](https://savbat.environment.gov.au/)
12. [CER: Savanna fire management methods](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/accu-scheme-methods/savanna-fire-management-methods)
13. [CER: Project reporting and audits](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/how-to-participate-accu-scheme/project-reporting-and-audits)
14. [CER: Multiple year reports for savanna fire management projects](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/accu-scheme-methods/savanna-fire-management-methods/multiple-year-reports-savanna-fire-management-projects)
15. [CER: Audits in our schemes](https://cer.gov.au/schemes/audits-our-schemes)
16. [CER: Draft Audit Thresholds Instrument 2025](https://cer.gov.au/news-and-media/public-consultations/draft-audit-thresholds-instrument-2025)
17. [Carbon Market Institute: Audits in the ACCU Scheme (explainer)](https://carbonmarketinstitute.org/app/uploads/2025/07/Audits-in-the-ACCU-Scheme_FINAL.pdf)
18. [CER: ACCU Scheme Compliance and Assurance Framework](https://cer.gov.au/document/accu-scheme-compliance-and-assurance-framework-0)
19. [CER: Australian carbon credit units (issuance overview)](https://cer.gov.au/schemes/australian-carbon-credit-unit-scheme/australian-carbon-credit-units)
20. [CER: ACCU project and contract register](https://cer.gov.au/markets/reports-and-data/accu-project-and-contract-register)
21. [Carbon Market Institute: Integrity Measures in the ACCU Scheme (explainer)](https://carbonmarketinstitute.org/app/uploads/2025/07/Integrity-Measures-in-the-ACCU-Scheme.pdf)
