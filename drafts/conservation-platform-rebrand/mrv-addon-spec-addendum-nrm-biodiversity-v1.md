# MRV Add-On Technical Spec — Addendum: Nature Repair Market Biodiversity-Certificate Path (v1)

**Status:** addendum to mrv-addon-technical-spec-v1.md, drafted Apr 28 2026, INTERNAL.
**Why this exists:** the parent spec is heavy on ACCU paths (soil 2021, environmental plantings 2024, savanna burning) but light on the Nature Repair Market biodiversity-certificate path, which is where peak bodies have the strongest natural product-market fit. NRM bodies, Landcare, and ICIN run land-management programs that map directly onto biodiversity-certificate projects. ACCUs require lab-grade SOC sampling and FullCAM modelling that few peak bodies are tooled to run; biodiversity certificates require ecosystem-condition monitoring at permanent plots, which their existing programs already produce.

This addendum specifies how the MRV add-on integrates with the two pieces of regulator-published infrastructure we have to plug into to be credible: PLANR (the DCCEEW planning tool, free, account-based) and the CER Biodiversity Market Register (the public registry of registered projects and issued certificates).

This document slots in as a new section 5.5 in the parent spec, plus updates section 10 (risk register) with one new row.

---

## 5.5 Nature Repair Market biodiversity-certificate path

The Nature Repair Market is the world's first legislated voluntary biodiversity credit market. The Clean Energy Regulator administers it. The first method, Nature Repair (Replanting Native Forest and Woodland Ecosystems) Methodology Determination 2025, was published 27 February 2025 and is the live entry point for any project today. Additional methods (catchment-scale biodiversity restoration, ecosystem condition uplift in modified landscapes, threatened-ecological-community recovery) are in DCCEEW's pipeline. Our integration boundary is the Replanting method on day one, with extensibility for the next two methods built into the data model from the start.

### 5.5.1 Why peak bodies are the natural buyer

The Replanting method's project floor is five hectares total activity area, with sub-areas of at least 0.2 ha. That floor is below typical commercial-developer scale and squarely inside the program footprint of NRM regional bodies, Landcare networks, and on-Country ranger programs. The aggregator economics that made our ACCU thesis work apply with even more force here, because:

- The minimum-viable project is small enough that single-property proponents struggle to justify the project-development overhead.
- Peak bodies aggregate dozens to hundreds of these in their normal program operations, with the spatial data already collected.
- The reporting cadence (every six months to five years depending on category) is compatible with the program-management cadences peak bodies already run.
- The qualified-monitoring-person requirement (ecologist or botanist or equivalent) is something larger peak bodies already employ; smaller bodies can pool through the federation tier.

The wedge is real: AgriProve is a project developer for soil ACCUs and is not in the biodiversity-certificate market. Cecil Earth's customer segment is farmers, property developers, and project developers — not biodiversity-certificate aggregators. Loam Bio is a biotech+project-developer hybrid in soil. None of these are positioned for the Replanting method's biodiversity-certificate path at peak-body scale. (See Research 3135 for the competitor verification.)

### 5.5.2 PLANR ingestion

PLANR (Platform for Land and Nature Repair) is DCCEEW's free, account-based, geospatial planning tool for environmental markets. It does mapping, environmental assessment, cost estimation, and biodiversity benefit forecasting. It uses existing spatial data to estimate biodiversity benefit, with on-ground assessment then verifying and updating results before CER registration.

NRM Regions Australia is already actively using PLANR. (Sara Castillo Rodriguez delivered "Planning a project using PLANR" at an NRM Regions Australia event in January 2026 — the slide deck is hosted at nrmregionsaustralia.com.au.) That is a live signal that the federation we are pitching is already familiar with the tool we propose to wrap.

PLANR is not the substitution risk. PLANR plans projects. It does not run the monitoring and reporting that the method requires after registration. Our integration is downstream of PLANR: a peak body uses PLANR to plan a project, exports the project plan, and ingests it into our system. We then run the monitoring, reporting, and audit pipeline from registration through the permanence period.

PLANR ingestion is a one-way pull. The integration shape:

- **PLANR project plan import** — accept the PLANR-exported project plan file (PDF + spatial files; PLANR does not currently expose an API). The spatial files become the project's CEAs (Carbon Estimation Areas equivalent for biodiversity) and the PDF is content-hashed and attached to the project record as the registration evidence package.
- **Cross-check** — our system validates that the PLANR plan's claimed activity area meets the method's >=5ha total / >=0.2ha sub-area floors and flags any sub-areas below the threshold.
- **Re-import on plan revision** — peak bodies revise PLANR plans during the project lifecycle. Our system supports a re-import flow that diffs the new plan against the previously imported one and records the diff as a project-plan-revision event in the audit log.
- **No automated PLANR scraping** — we do not log into PLANR on the user's behalf. The peak body downloads from PLANR and uploads to our system. This keeps regulatory accountability where it belongs and avoids credential-handling risk.

If DCCEEW publishes a PLANR API, we adopt it. Until then, file-based exchange.

### 5.5.3 Monitoring and reporting requirements (Replanting method)

The Replanting method tracks ecosystem condition indicators at permanent sampling plots. Reporting cadence is every six months to five years depending on the reporting category the project elects. For projects with activity area below 10 ha, each ecosystem-condition threshold value must be reached in 100% of permanent sampling plots; for projects of 10 ha and above, in 75% of plots.

The MRV pipeline encodes this as:

- **Permanent sampling plot record type** — each plot has a fixed location (lat/lon, plot ID), an establishment date, an ecologist of record, and a time-series of ecosystem-condition observations. The plot record is bi-temporal (valid_from / valid_to per observation) so that historical reports can be reproduced exactly.
- **Ecosystem-condition indicators** — structured per the method's published indicator set. The indicator schema is method-versioned (e.g. `replanting_method_2025_v1.0`) so that method revisions are handled by adding a new indicator version, not editing the existing one.
- **Threshold reconciliation** — at each reporting boundary, the pipeline computes the proportion of plots that have reached each indicator's threshold value, applies the 100%-or-75% rule based on activity area, and flags the project as on-track / at-risk / non-conforming.
- **Qualified-person signoff** — the ecologist or botanist of record signs off on the period's monitoring report through the admin UI. Their qualification record (degree, registration, prior projects) is stored alongside the signoff event.
- **Reporting category election** — the project administrator elects the reporting category (six-month, annual, two-year, five-year) at registration. The pipeline schedules the reporting deadlines automatically and surfaces upcoming deadlines on the federation admin dashboard.

### 5.5.4 CER Biodiversity Market Register integration

The CER's Biodiversity Market Register is the public registry of registered NRM projects and issued biodiversity certificates. It publishes seven CSV files plus an Excel file:

1. Project details
2. Project locations
3. Project plans
4. Biodiversity reports
5. Related projects
6. Project and certificate history
7. Audit reports

The register is download-only. There is no published API at the time of writing. Updates are periodic and the CER commits to keeping the register up to date and publishing corrections in the next register update.

Our integration shape:

- **Register pull job** — a daily job downloads the seven CSV files (these are tiny — 4.86 KB for project details, 4.65 KB for project locations, sub-1KB for the rest), parses them into a normalised internal schema, and reconciles with our internal project records.
- **Reconciliation alerts** — if a peak body's project appears in our system but not in the public register (registration not yet live) or appears in the register but not in our system (drift), we alert the project administrator.
- **Certificate-history mirror** — the certificate-history CSV gives us the public record of certificates issued, transferred, and cancelled. We mirror this into the project record and surface it on the admin UI alongside the internal monitoring data.
- **Audit-report mirror** — the audit-reports CSV publishes the metadata for each project's audit history. We attach this to the project's audit log, content-hash the corresponding audit document if the peak body uploads it, and use the register entry as a cross-check that our internal record matches the public record.
- **Submission output that mirrors the register schema** — when we generate a peak body's submission package, we structure the data to align with the seven-file register schema. This means the peak body's CER Online Services submission produces register entries that are internally consistent with what we already have.

If the CER publishes a Biodiversity Market Register API in the future, we replace the daily CSV pull with the API. The internal schema stays stable.

### 5.5.5 Method extensibility

The data model accommodates additional NRM methods without schema migration. Each project carries a `method_id` (e.g. `replanting_native_forest_2025_v1.0`) and the method-specific indicator set, threshold rules, and reporting cadence are loaded from a method-registry configuration. Adding a method is a configuration change, not a code change. This is important because DCCEEW has a clear pipeline of additional methods and we do not want to be locked to one.

The integration boundaries that stay stable across methods:

- PLANR project plan import shape (one method, one method-aware ingestor)
- Permanent sampling plot record type (universal)
- Qualified-person signoff workflow (universal)
- CER Online Services submission package generator (per-method submission template, common output format)
- CER Biodiversity Market Register reconciliation (universal)

### 5.5.6 Pricing impact

The biodiversity-certificate path uses the same $1,500 per month flat add-on plus per-project issuance fee structure as the parent spec. No change. The biodiversity-certificate path can run on the same operational footprint and tenant Supabase substrate. The peak body's monthly fee covers any number of NRM biodiversity-certificate projects in the same tenant.

The per-project issuance fee is recoverable inside the typical $5-15k of NRM project-development cost a peak body absorbs from grant funding, which is materially better economics than the $15-50k per-project industry-norm dMRV-provider fee.

---

## Update to risk register (parent spec section 10)

Add the following row:

### 10.5 Method pipeline timing

DCCEEW has additional NRM methods in the pipeline beyond Replanting. The catchment-scale biodiversity restoration method, the ecosystem condition uplift method, and the threatened-ecological-community recovery method are all in development. Their published draft methods will require schema configuration updates and possibly additional indicator types. We have one team member capable of method-configuration work. If three methods publish inside a six-month window we will hit a configuration-bandwidth bottleneck. Mitigation: maintain a method-staging environment so that draft-method configuration can begin before the determination is gazetted.

---

## What changes in the parent spec

This addendum is intended to be folded into mrv-addon-technical-spec-v1.md as a new section 5.5 (between the existing section 5 CER submission pipeline and section 6) plus a new risk register row 10.5. Section 1 (executive summary) gains one sentence:

> The add-on covers the Nature Repair Market biodiversity-certificate path under the Replanting Native Forest and Woodland Ecosystems method (live since Feb 2025), with extensibility for the additional NRM methods in DCCEEW's pipeline.

Section 4 (engineering boundaries — what we do not build) gains one bullet:

> We do not build a competing planning tool to PLANR. Peak bodies use PLANR for project planning and we ingest the resulting project plan downstream.

The pricing section is unchanged. The integration with FullCAM, RothC, and the ACCU paths is unchanged. The federation core architecture is unchanged. The biodiversity-certificate path is purely additive.

---

## Sources

- CER Biodiversity Market Register: https://cer.gov.au/markets/reports-and-data/biodiversity-market-register
- CER Nature Repair Market scheme: https://cer.gov.au/schemes/nature-repair-market-scheme
- DCCEEW Nature Repair Market: https://www.dcceew.gov.au/environment/environmental-markets/nature-repair-market
- DCCEEW Platform for Land and Nature Repair (PLANR): https://www.dcceew.gov.au/environment/environmental-markets/agriculture-stewardship/platform-land-nature-repair
- DCCEEW Replanting native forest and woodland ecosystems method: https://www.dcceew.gov.au/environment/environmental-markets/nature-repair-market/replanting-native-forest-woodland-ecosystem-method
- CER Replanting method: https://cer.gov.au/schemes/nature-repair-market-scheme/replanting-native-forest-and-woodland-ecosystems-method
- NRM Regions Australia "Planning a project using PLANR" presentation (Sara Castillo Rodriguez, Jan 2026): https://nrmregionsaustralia.com.au/wp-content/uploads/2026/01/Planning-a-project-using-PLANR_Sara-Castillo-Rodriguez.pdf
- S&P Global launch coverage: https://www.spglobal.com/energy/en/news-research/latest-news/energy-transition/030425-australia-launches-worlds-first-legislated-voluntary-biodiversity-credits-market

Verification status: all section 5.5 claims have a published-source backing in the URLs above. The competitor non-coverage claim is backed by Research 3135 in Neo4j and pending verification by fork_mohbh2g8_9144e5 (customer-logo scan in flight).
