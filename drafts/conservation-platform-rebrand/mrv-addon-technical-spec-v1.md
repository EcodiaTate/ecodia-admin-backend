# MRV Add-On Technical Specification (v1)

**Document**: Engineering specification for the digital MRV add-on layered on top of the [PLATFORM_NAME] enterprise tier.
**Audience**: Technical reviewer at a conservation peak body (Landcare Australia, Greening Australia, NRM Regions Australia, similar). CTO, Head of Digital, programs lead with technical literacy.
**Status**: v1, draft for federation pitch v2 backstop. Authored by EcodiaOS, 27 April 2026.
**Source of truth for scope**: Neo4j Research node 3079, "Australian carbon MRV market 2026, peak-body dMRV gap."
**Companion document**: `federation-pitch-deck-v2.html` (slides 06 and 07).

---

## TL;DR

This add-on is a software-only digital MRV layer that sits on top of the [PLATFORM_NAME] enterprise tier and lets a conservation peak body operate as the aggregating proponent for sub-commercial-scale ACCU projects across its membership. It targets the 2021 soil carbon measurement-and-models method, the 2024 environmental plantings FullCAM method, and the savanna burning methods where peak-body relevance applies. It wraps the Clean Energy Regulator's blessed model (FullCAM, with RothC inside it) rather than substituting for it, ingests field, satellite, and lab inputs through the same Supabase substrate the federation core already runs in production, content-hashes every measurement and model run for audit, and produces a CER Online Services submission package with human-in-the-loop signoff. Pricing is a $1,500 per month flat add-on plus a per-project issuance fee, with no share of the credit revenue. Engineering boundaries are explicit: we do not build the soil model, the registry, or the credit market.

---

## 1. Scope of the MRV add-on

The add-on initially supports three ACCU Scheme methods. Method choice was made on three filters: peak-body relevance, sub-commercial-scale viability, and absence of an entrenched commercial dMRV competitor.

### 1.1 Methods in scope at v1

**Soil carbon, 2021 method.** Full title: "Carbon Credits (Carbon Farming Initiative, Estimating Soil Organic Carbon Sequestration Using Measurement and Models) Methodology Determination 2021." Credits ACCUs for measured increases in soil organic carbon from one or more new or materially different land-management activities (the determination lists 13 eligible activity options). This is the active soil method. It requires soil sampling by an independent technician at baseline and at re-sampling rounds (the determination's CEAs, Carbon Estimation Areas, and stratification rules apply).

**Environmental and mallee plantings, FullCAM method 2024.** Full title: "Carbon Credits (Carbon Farming Initiative, Reforestation by Environmental or Mallee Plantings, FullCAM) Methodology Determination 2024." This replaced the 2014 method when the 2014 determination expired on 30 September 2024. Credits ACCUs for biomass sequestration in mixed-species native plantings modelled in FullCAM under the appropriate calibration. Many small to mid peak-body member projects sit naturally inside this method.

**Savanna fire management, where peak-body relevant.** The Emissions Avoidance and Sequestration savanna burning methods cover early dry-season burning that reduces emissions from late-season wildfire and, under the sequestration variant, accumulates dead organic matter. Peak-body relevance is geographic: the method applies in the high-rainfall and low-rainfall savanna zones across northern Australia, so this is in scope only for tenants whose membership operates inside those zones.

### 1.2 Methods deliberately out of scope at v1

We exclude two adjacent method families on commercial-positioning grounds. Livestock methane reduction methods sit inside a competitive frame already captured by AgriProve and a small set of feed-additive specialists; the unit economics there assume a feedlot-style intensive-livestock enterprise that is rarely the peak-body member shape. Human-Induced Regeneration (HIR) is the broadacre native-vegetation method that GreenCollar and other aggregators have built their P&L around; the entry-cost shape favours commercial aggregation, so a peak-body MRV layer is not the right wedge there. Both can be added later without a substrate change; they are excluded at v1 because the wedge is sub-commercial-scale projects that sit below the threshold where commercial aggregators engage.

### 1.3 Project-tenant model

Inside a peak-body tenant, each ACCU-eligible project is a sub-tenant. A project has one method, one or more participants (a single landholder, or a participant collective under the method's eligible-interest-holder rules), one geographic boundary (CEA or planting boundary, expressed as a polygon in EPSG:4326), one model run series, and one submission cycle. Multi-method tenants are supported; one project, one method.

---

## 2. Data ingestion architecture

The add-on uses the same Supabase Postgres substrate the federation core already runs on, in a separate logical schema (`mrv`) with row-level security keyed on `tenant_id` and `project_id`. Five ingestion sources land in normalised tables; raw payloads land in content-addressable file storage; every ingestion event writes an audit row.

### 2.1 Field sensors (LoRa or Sigfox), optional

The add-on accepts a generic device-event payload over MQTT or HTTPS webhook. We do not bundle a specific sensor vendor's SDK. A tenant can ship soil-moisture probes, temperature loggers, or weather-station feeds in a JSON shape (`{device_id, timestamp_utc, lat, lon, readings: {<key>: <value>}}`) and they land in `mrv.sensor_event`. We deliberately do not build a sensor-management UI at v1; the operating assumption is that tenants who run sensors already have a vendor stack (The Things Network, Senet, a Sigfox provider) and just need a sink.

### 2.2 Satellite imagery

Two providers are supported through a unified `mrv.imagery_capture` interface.

- **Sentinel-2 L2A surface reflectance** through Microsoft's Planetary Computer STAC API. Free for the volume any peak-body member project will consume. 5-day revisit at the equator, 10m resolution on the visible and NIR bands used for NDVI, NDMI, and EVI time series. Pulled on a 7-day cron per project AOI and cached in object storage as Cloud-Optimized GeoTIFF.
- **Planet Labs PlanetScope**, paid tier, optional. Daily 3m revisit. Tenant supplies their own Planet API key; consumption is metered per tenant and surfaces inside the add-on dashboard. We do not resell Planet imagery; the tenant relationship sits directly with Planet.

### 2.3 Drone uploads

Direct GeoTIFF upload through the admin web app, multipart up to 2GB per asset, signed S3 URLs against the same Supabase storage bucket. Required metadata on upload: capture date, sensor type (RGB, multispectral, LiDAR), GSD (ground sample distance) in metres. Files land in object storage; a derived row in `mrv.imagery_capture` carries the metadata and a content hash.

### 2.4 Manual field notes from the mobile app

The federation core already ships an offline-capable Capacitor mobile app with GPS-stamped event records. The MRV add-on extends the existing event schema with method-specific fields gated on the project's method. For the 2021 soil method, that includes CEA designation, soil core depth, sampling round, and the chain-of-custody fields the determination requires. For environmental plantings, it includes species mix, planting density, and survival-check observations. Field notes round-trip back to the central database when the device next comes online.

### 2.5 Lab results, soil cores

Independent soil sampling technicians submit cores to NATA-accredited labs. Lab CSV results land through the same 30-minute Edge Function cron the federation core uses for Excel reverse-sync. The function expects a tenant-configured CSV shape (lab-specific, mapped once at onboarding) and writes results into `mrv.soil_lab_result`, joined to the field record by sample ID. GPS metadata is required on every lab row; rows without GPS are quarantined for admin reconciliation.

### 2.6 Historical baseline data

Three baseline sources are ingested once at project setup and refreshed as authoritative sources update.

- **State cadastre.** Per-state property boundary feeds (NSW Spatial Services, Vicmap, Queensland Globe, etc.). Used to verify project boundary alignment and eligible-interest-holder coverage.
- **ABARES Australian Soil and Landscape Grid.** Soil organic carbon stock baseline (3-arcsecond grid, ~90m resolution). Used as the prior in the 2021 soil method's measurement-and-models pipeline.
- **TERN AusCover archive.** Historical NDVI and biomass time series back to 2000, used as the change-detection baseline for environmental plantings projects.

---

## 3. Verification pipeline

Three pipelines run on top of the ingested data. Each writes its outputs back into `mrv.model_run` with a content hash on inputs, the model version, and the run timestamp.

### 3.1 Photogrammetry for biomass estimation

For environmental plantings projects with drone or high-resolution satellite imagery, OpenDroneMap (ODM) runs as a containerised job on the VPS, producing orthomosaic, DSM, and canopy height model outputs. Tree-crown segmentation runs on the DSM-minus-DTM canopy height model using a watershed-segmentation algorithm tuned for native-mix plantings. Per-tree metrics (crown area, height) feed the FullCAM input set for the environmental plantings method. ODM is deliberately chosen over a commercial photogrammetry SaaS to keep per-project compute cost in the low tens of dollars per run.

### 3.2 NDVI and EVI time series for vegetation cover

For both environmental plantings and savanna projects, a per-AOI NDVI and EVI time series is computed from the Sentinel-2 cache and stored as a Parquet file per project. The series drives change-detection for the planting-establishment evidence trail and provides corroborating evidence that the project area has not been cleared during the crediting period. For savanna projects, the same pipeline produces fire-scar detection using burned-area indices (NBR), cross-checked against the NAFI (North Australia Fire Information) operational service.

### 3.3 Soil carbon model integration through FullCAM

This is the load-bearing piece, and it is worth being concrete about the interface.

The Clean Energy Regulator requires FullCAM for the environmental plantings methodology and FullCAM (with RothC as the soil sub-model) feeds into the soil method's measurement-and-models reconciliation. FullCAM runs on the Department of Climate Change, Energy, the Environment and Water (DCCEEW) infrastructure as part of the FullCAM modernisation program. There is a public web interface, and there are FullCAM APIs that require an API subscription key. Both the 2020 and 2024 Public Release versions of FullCAM are currently available.

The add-on integrates as a wrapper around the FullCAM API. Concretely:

- **Tenant supplies FullCAM API subscription key.** Stored encrypted-at-rest in Supabase Vault, scoped to the tenant.
- **Per-project FullCAM workspace.** The add-on builds the FullCAM input set (site, climate, soil, management events, planting design) from project records and submits to the FullCAM API.
- **Run metadata captured.** FullCAM model version, calibration used, run timestamp, output state.
- **Outputs stored.** Per-year biomass and soil-organic-carbon outputs land in `mrv.fullcam_output`.
- **Re-runs are cheap.** When a method version updates or a project record is corrected, the run can be re-issued; the prior run is not deleted, it is superseded with a `supersedes` foreign key for the audit trail.

We do not substitute for FullCAM. The CER's published guidance is unambiguous that project proponents must use FullCAM for the environmental plantings method, and the soil method's regulated fallback path uses FullCAM's RothC sub-model. Wrapping the regulator-blessed model is the correct shape; replacing it would be a regulatory dead end.

For the soil method specifically, the measurement-and-models reconciliation runs as: lab-measured soil organic carbon stocks at sampling round R, paired with FullCAM RothC-modelled stocks for the same period under the project management activities, reconciled per the 2021 determination's adjustment rules. The CER's "model start dates and approaches to determine carbon abatement" guidance defines the reconciliation procedure; we encode that procedure as a deterministic pipeline rather than a free-form spreadsheet.

---

## 4. Audit trail and immutability

Every measurement, lab result, satellite capture, model run, and methodology version stamp gets a SHA-256 content hash and a signed timestamp. The audit trail is bi-temporal: every row carries both `event_time` (when the thing happened in the field) and `system_time` (when it landed in our system), and changes are recorded as new rows with a `supersedes` foreign key, never as in-place updates.

### 4.1 Storage shape

Postgres tables hold the relational rows; an object-storage bucket holds the raw files (lab CSVs, GeoTIFFs, FullCAM input and output XML, drone imagery). Files are content-addressable: the storage key is the hash, and the relational row points to the hash. Two ingestions of the same lab CSV produce one stored object and two `mrv.lab_ingest_event` rows pointing at it.

### 4.2 Why Postgres plus content-addressable storage rather than chain-everything

The peak-body buyer does not ask for blockchain anchoring. They ask for: can we reproduce a submission five years from now if the CER queries it. Postgres point-in-time recovery, content-addressed file storage, and a tamper-evident hash chain on the audit log answer that question at materially lower cost than running an L2 chain or a permissioned Hyperledger network. The hash chain on the audit log gives the tamper-evidence property without the per-write transaction fee and operational overhead of an on-chain anchor.

We do reserve a hash-anchoring hook. If a tenant later wants periodic anchoring of audit-log Merkle roots to the Polygon PoS contract that already carries Ecodia DAO LLC's public identifier, the hook is a per-tenant configuration flag and a daily anchoring job. Cost order: a few cents per day in gas. It is off by default because no current peak-body buyer has asked for it, and the CER has not signalled it as a requirement.

### 4.3 Method-versioning

Each project record carries the methodology determination version it was registered under (e.g. `soil_2021_v1.3`). When the CER updates the method, the project enters a method-version-review state; the project administrator confirms the migration path, model runs are re-issued under the new version, and the prior runs are preserved in the audit log as superseded.

---

## 5. CER submission pipeline

What the system produces at the end of a crediting period is a submission package suitable for upload through the Clean Energy Regulator's Online Services platform. ACCU forms have transitioned to Online Services from the prior Client Portal; the submission shape mirrors what Online Services accepts.

### 5.1 Submission package contents

Per project, per crediting period, the package contains:

- **Project registration application** (one-time, at project setup): proponent details, project boundary as polygon and area, eligible-interest-holder evidence, method declaration, project-area land-use history.
- **Monitoring report**: structured per the relevant method's monitoring requirements. For the soil method, sampling round summaries, lab certificates, FullCAM run outputs, reconciliation worksheet, CEA-by-CEA stock-change tables. For environmental plantings, planting records, survival checks, FullCAM outputs, NDVI evidence series. For savanna, burned-area maps, fire history, eligibility evidence.
- **Methodology compliance evidence**: a per-clause checklist mapped to artefacts in the audit trail, with content hashes.
- **Issuance request**: ACCUs requested for the period, with the supporting calculations.
- **Audit support pack**: full bi-temporal audit log for the crediting period, FullCAM input and output XML files, lab certificates, signed-off CEAs.

Outputs are produced as PDF (for human-readable forms) and structured XML or JSON (for machine-readable artefacts). Templates are versioned and tracked under `mrv.submission_template`.

### 5.2 Human-in-the-loop signoff

The system does not auto-submit. The peak body's nominated authorised proponent reviews the assembled package in the admin UI, signs off on each section with a recorded approval event, and downloads the bundle for upload through CER Online Services through their own credentialled login. This is the right boundary: the legal proponent for the project is the peak body or the participating member, and the CER credential is theirs. Our role stops at producing a complete, internally consistent, audit-trail-backed submission package.

### 5.3 Why the submission stays a download rather than a direct API push

The CER's Online Services platform does not at this time expose a third-party-system submission API for ACCU project applications and monitoring reports. The submission flow is operator-driven through the Online Services UI. Even if a programmatic interface arrives, the human-in-the-loop signoff stays, because the proponent's regulatory accountability does. We will adopt a programmatic submission path the day the CER publishes one and the peak-body buyer asks for it.

---

## 6. Multi-tenant model

Tenant isolation is the load-bearing security property. The add-on inherits the federation core's multi-tenancy model and extends it.

### 6.1 Tenant hierarchy

```
peak_body_tenant (e.g. "State Landcare Network")
  └── project_sub_tenant (e.g. "Member X, soil method, 120ha")
        └── method-specific records (CEAs, plantings, savanna AOIs)
```

A peak-body administrator sees all projects under their tenant. A project administrator sees only their project. A member operating their own land sees only their participant role on the relevant project.

### 6.2 Row-level security

Every table in the `mrv` schema has RLS enabled. The base policy is: a row is visible if and only if `tenant_id` matches the JWT's `tenant_id` claim AND (the user has a tenant-admin role OR `project_id` is in the user's authorised project list). Service-role queries (for cron jobs, model runs, scheduled submissions) bypass RLS by design; all service-role paths are audited.

### 6.3 Data egress and tenant offboarding

Tenant data is exportable on request as a single tarball containing the tenant's relational rows (newline-delimited JSON), all object-storage assets, and a manifest with content hashes. Termination of the licence does not remove tenant data from our storage immediately; the contract pattern is a 30-day grace window, then permanent deletion with a deletion certificate produced as the final artefact.

### 6.4 Cross-tenant data leakage

There is no scenario in which one peak body's project data is visible to another peak body. Shared base-layer caches (Sentinel-2 imagery, ABARES soil grid, NAFI fire scars) are public datasets and are stored in a single shared cache for compute economy; per-tenant project records, model runs, lab results, and field events live in tenant-isolated tables.

---

## 7. What we do not build

Engineering maturity shows up in what is excluded as much as in what is included. The boundaries below are explicit so that a technical reviewer can rule out scope misunderstanding before contract.

- **The soil-carbon model itself.** FullCAM with RothC is the regulator-blessed model. We wrap it through the FullCAM API. We do not write a competing biogeochemical model and we do not get into a position where we have to defend our model's parameterisation to a CER reviewer.
- **The registry.** ACCUs are recorded in the Australian National Registry of Emissions Units operated by the CER. We do not run a registry, mint our own credit unit, or attempt to interoperate at the registry layer beyond what the CER's submission process exposes.
- **The credit market.** ACCU spot-market and auction price discovery happens on existing market venues (Jarden, CORE Markets, the CER's auction process). We do not match buyers and sellers, hold credits as principal, or quote prices.
- **Project finance.** Credit pre-financing, off-take agreements, and project-level capital are not in our offering. Members and aggregators handle these directly with their counterparties.
- **Methodology determination authoring.** We do not write new methods or attempt to influence the CER's methodology development pipeline. We follow the methods that exist.
- **Soil sampling.** The 2021 method requires an independent soil sampling technician; that is a regulated role we do not take.
- **NATA-accredited lab analysis.** Lab work is done by accredited labs, full stop. We ingest CSV results.

These exclusions are mirrored in the licence agreement as well as in this spec, so that a peak-body buyer cannot reasonably assume we are stepping into one of these zones.

---

## 8. Interfaces

The add-on exposes a tight, conservative interface surface. Every endpoint is versioned; every state-changing endpoint is idempotent on a client-supplied request ID.

### 8.1 REST API for tenant operations

Exposed at `https://api.[platform-domain]/mrv/v1/`. Authenticated through the federation core's existing JWT issuer. Endpoints (selected):

- `POST /tenants/{tenant_id}/projects` create a project under a peak-body tenant.
- `GET /projects/{project_id}/state` current project state, including method version, recent model runs, last submission.
- `POST /projects/{project_id}/field-events` ingest one or many field events (soil cores, planting records, fire events).
- `POST /projects/{project_id}/imagery` register an imagery capture (drone upload signed URL, satellite cache reference, or PlanetScope pull).
- `POST /projects/{project_id}/model-runs` trigger a FullCAM run or photogrammetry pipeline.
- `GET /projects/{project_id}/audit-log` paginated bi-temporal audit log for the project.
- `POST /projects/{project_id}/submission-packages` assemble a submission package for a crediting period.

Rate limiting is per-tenant. Schema is OpenAPI 3.1, published per release.

### 8.2 Webhook for measurement events

A tenant configures one or more webhook URLs. Every state-significant event (`field_event.ingested`, `model_run.completed`, `submission_package.assembled`, `audit_log.entry.added`) fires a signed POST to the configured URLs with at-least-once delivery semantics and a 24-hour retry window. Signatures use HMAC-SHA256 with a per-tenant rotating secret.

### 8.3 Admin dashboard

Web admin under the federation core's existing admin shell, with an MRV section that surfaces:

- Project list and per-project state.
- Audit-log viewer with bi-temporal filtering.
- Model-run history per project, with diff between runs.
- Submission-package builder and signoff queue.
- Tenant settings (FullCAM API key, NDVI cron schedule, webhook URLs, methodology compliance contacts).

### 8.4 Mobile data-collection PWA

The federation core's offline-capable Capacitor mobile app is extended with method-aware forms (soil core, planting record, savanna burn record). The PWA build is the same codebase. Offline capture is mandatory; many field events happen with no signal. Sync conflicts are surfaced to the project administrator under the existing Excel-sync conflict pattern.

The interface count is intentionally small. Adding more surface (a public marketplace, a participant-facing finance dashboard, a third-party audit-firm portal) is a tomorrow problem; v1 is the irreducible engineering scope.

---

## 9. Pricing rationale

The add-on price is $1,500 per month flat per tenant, on top of any [PLATFORM_NAME] tier, plus a per-project issuance fee billed at submission. The numbers behind this:

### 9.1 Direct compute and storage cost

- **Sentinel-2 imagery cache through Planetary Computer**: free at the volumes in scope.
- **PlanetScope (optional)**: passed through to the tenant on their own API key.
- **Object storage**: Supabase storage on the existing project. Per-tenant per-month cost in the order of $5 to $30 per active tenant depending on how many drone uploads they run.
- **Compute for OpenDroneMap and pipeline jobs**: VPS-based, amortised. Per-tenant marginal cost in the order of $20 to $80 per month for a typical mid-tenant.
- **FullCAM API**: tenant-supplied subscription key, no pass-through.
- **Database**: Supabase Postgres on the existing project, marginal cost negligible at the row volumes typical for a peak-body MRV tenant (tens of thousands of rows per active project per year).

Direct infrastructure cost lands in the $50 to $200 per active tenant per month range. The flat $1,500 per month covers infrastructure plus the major cost line, which is support.

### 9.2 Support is the real cost

The support workload for an MRV tenant is materially higher than for the federation core. Reasons: methodology compliance questions, FullCAM input curation, lab-result ingestion debugging, audit pack reviews, CER feedback responses. Budgeting one to two hours of skilled time per tenant per week absorbs the bulk of the $1,500 figure.

### 9.3 Per-project issuance fee covers variable load

Issuance is bursty. A project at submission cycle drives a multi-day spike in compute (re-running FullCAM under final inputs, assembling the submission package, generating the audit support pack) and a meaningful spike in support time. Charging a per-project issuance fee at submission, rather than baking it into the monthly, keeps the monthly stable and aligns variable cost with variable revenue. Indicative range: $500 to $2,000 per project per crediting period, depending on method and project scale; this is set per tenant in their licence schedule.

### 9.4 Comparison to revenue-share aggregators

A mid-scale aggregator's published share is around 30% of credit revenue. Worked example: a 2,000-credit project at a $30 per ACCU issuance price is $60,000 of credit revenue, of which a 30% share is $18,000 captured by the aggregator. Under the MRV add-on the same project pays its share of the tenant's $1,500 per month flat rate plus its issuance fee. For a peak body running 30 projects under the add-on, the per-project fully loaded cost is roughly the issuance fee plus $600 per year of allocated platform cost, which on the same $60,000 project lands the all-in at single-digit thousands rather than 30% of revenue.

This is structural, and the structural difference is the offer. We are selling software-as-infrastructure paid for as infrastructure. The credit revenue stays with the steward who did the work.

---

## 10. Risk register

Engineering specs that omit risks are not engineering specs. The five risks below are the ones that actually move outcome.

### 10.1 Method-versioning risk

The CER updates methodology determinations every few years. The 2014 environmental plantings method expired 30 September 2024 and was replaced by the 2024 method; the 2021 soil method is on its current revision but will revise. When a method updates, projects in flight must migrate or run out the prior method's transition window, and the model-run pipeline must support both versions concurrently for the duration.

**Mitigation.** Method version is a first-class field on `mrv.project`. Pipelines key on method version. Prior-version pipelines are not deleted on method update; they are marked deprecated and run in a maintenance mode for the duration of any project still in transition. Method updates are tracked as their own engineering work item with a defined cutover window.

### 10.2 Satellite imagery cost-creep

Free Sentinel-2 access through Microsoft Planetary Computer is the current default. If Microsoft monetises the API or rate-limits commercial users, or if Sentinel-2 itself moves to a paid tier (currently no signal that this is planned), per-tenant cost shifts. PlanetScope is already paid and passed through.

**Mitigation.** Imagery sources are abstracted behind the `mrv.imagery_capture` interface. A second free-tier path through ESA's Copernicus Data Space Ecosystem is implemented as a fallback. Tenant cost exposure on free-tier imagery is capped at zero at v1; if costs appear, the licence schedule can be amended with explicit notice.

### 10.3 FullCAM black-box trust

FullCAM is not open source. Wrapping it means we do not see the internal calculation; we see inputs and outputs. If a CER reviewer questions a model output, our position is "this is what FullCAM produced under the regulator-blessed configuration."

**Mitigation.** Every FullCAM run captures the full input XML, output XML, model version, and calibration. Rerun under the same inputs and version is bit-deterministic; we can always reproduce a prior result. The compliance position is that we used the regulator's model as specified. Peak-body buyers consistently prefer wrapping FullCAM to substituting for it, exactly because the compliance defence is simpler.

### 10.4 Audit failure at CER review

A project gets to monitoring report submission and the CER review surfaces a deficiency: missing eligible-interest-holder evidence, sampling-round non-conformance, CEA stratification error.

**Mitigation.** The submission-package builder runs a methodology-compliance checklist as a precondition. The checklist is per-method, mapped clause-by-clause to the determination. Submissions cannot be marked ready-for-signoff with unresolved checklist items. Peer-reviewed submissions before our first live tenant submission. Audit-failure cases trigger a mandatory post-incident learning entry and a checklist-rule update if the root cause is a checklist gap.

### 10.5 Tenant credential exposure

Tenant FullCAM API subscription keys, Planet API keys, and lab integration credentials are stored in the system. Key exposure would be material.

**Mitigation.** All tenant secrets are stored in Supabase Vault, encrypted at rest with project-scoped keys. Service code accesses secrets through a narrow shim with audit logging on every read. No secret is ever logged. Quarterly secret rotation is offered as a managed service; tenants who rotate independently can do so through the admin dashboard.

---

## Appendix A: Method version table at v1

| Method (short) | Determination | Current version | Sub-model | In scope at v1 |
|---|---|---|---|---|
| Soil carbon (M&M) | Soil Organic Carbon Sequestration Using Measurement and Models 2021 | 2021 | RothC inside FullCAM | Yes |
| Environmental plantings | Reforestation by Environmental or Mallee Plantings FullCAM 2024 | 2024 (replaced 2014, expired 30 Sep 2024) | FullCAM | Yes |
| Savanna fire management | Savanna burning methods (EAS variants) | Current | Method-internal | Yes, where peak-body geographically relevant |
| Beef herd management | Beef Cattle Herd Management 2023 | 2023 | Method-internal | No, out of scope at v1 |
| HIR | Human-Induced Regeneration | Current | FullCAM | No, out of scope at v1 |

## Appendix B: Open engineering questions for v1.1

- Whether to add native ESA Copernicus Data Space ingestion as the primary imagery path (currently fallback).
- Whether to expose a read-only public project-status endpoint for tenants who want third-party audit firms to subscribe to webhook events directly.
- Whether to add a participant-facing mobile UX for the soil method's sampling-round flow, or keep that admin-only at v1.
- Whether the per-project issuance fee should be a flat figure or a sliding scale on credits issued; current default is flat, set per tenant.

---

*Authored by EcodiaOS, algorithmic manager of Ecodia DAO LLC (Wyoming, ID 2026-001944432). Document v1, 27 April 2026. Companion to federation pitch v2.*
