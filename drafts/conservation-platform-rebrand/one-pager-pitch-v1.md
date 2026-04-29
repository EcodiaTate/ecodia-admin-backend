[INTERNAL]

# Conservation Platform - One-Page Pitch v1

**Author:** EcodiaOS (fork fork_mojkrsmz_b528e4)
**Date:** 2026-04-29
**Status:** Draft for Tate review. Tate-blocker on platform name. Until stamped, this doc uses `[Platform]` as placeholder. Find-and-replace once Tate stamps.
**Purpose:** Single-page value proposition for Australian conservation peak bodies and regional NRM bodies. Rendered at the top of any tailored deck or shipped as an attachment to a warm-intro outreach email after Tate green-lights per the no-unilateral-client-contact rule.
**Format:** plain markdown for v1. v2 ships as a 1-page PDF rendered through `/api/docs/render` once Tate stamps the name and the hero line.

---

## Hero line (v1, lock once Tate stamps the platform name)

If your peak body coordinates landholders running ACCU, Nature Repair Market, or DCCEEW grant projects, [Platform] is the operational spine that turns spreadsheets, Microsoft Forms, and SharePoint masters into CER-compliant evidence pipelines. One tenant per body, configured for the methods you actually run. Tenant zero is in production today inside a charity in your demographic, on a $24/month server on the Sunshine Coast.

---

## Three things [Platform] gives you

**1. Tenant zero is real, not a roadmap.** I built this for one Australian youth conservation charity first and lived with it for six months before considering a second tenant. 108 database migrations, 17 Edge Functions, App Store and Google Play, hundreds of events logged, an idempotent two-way sync to a SharePoint master sheet running on a 30-minute cron that has not silently dropped a row. The platform handles offline event check-in, photo-with-metric capture, configurable impact metrics per local group, a six-tier role hierarchy from participant through admin, and a federation shape that rolls local groups up to regions up to a national view. Discovery calls open with a live demo of the operational data of a real Australian charity in production, anonymised by default.

**2. Hosted and maintained for $5,000 to $7,000 per month per tenant body, with the MRV add-on at $1,500 per month per active method stream.** Build fee covers per-tenant configuration: theme, branch and region naming, custom impact metrics, integrations to your existing reporting templates. Build fee paid as deposit on signing plus delivery or first-funding-tranche trigger. The monthly licence covers hosting pass-through, security patches, minor bug fixes, observability, and platform development that lands in your build over the licence term. Termination on either side at 30 days notice. Your data is yours, with export available on request. The IP-retention model is the same one the lighthouse deployment runs on at $200/month, scaled for peak-body operational complexity.

**3. Per-tenant branded multi-tenant scaffold built for Australian conservation context specifically.** Wraps FullCAM for soil. Wraps CFI-MER-2018 submission templates. Configures per-method evidence schemas for savanna fire, Cultural Fire Credits, Replanting Native Forest, Nature Repair Market biodiversity certifications, and the DCCEEW grant-program reporting templates regional NRM bodies are running today. Sync layer keeps your existing SharePoint, Google Sheets, and Microsoft Forms intake intact, so you do not have to migrate funder reporting templates to switch operational platforms. Your branch and sub-unit naming is yours: Coastcare, Bushcare, Rivercare, Junior Landcare, ranger groups, regional networks, whatever the federation calls itself. The platform's generic core is members + branches + events + impact metrics + operational sync. Anything beyond that is custom-build, scoped and priced separately.

---

## What makes this different from the alternatives you have looked at

- **AgriProve and GreenCollar serve large-landholder commercial-scale projects.** The per-project economics work for them at scale and break for sub-commercial peak-body-aggregated projects. [Platform] is built for the long tail: regional NRM bodies coordinating 80 landholders, ranger groups running multi-method portfolios, Indigenous aggregators running cultural-knowledge evidence schemas. Sub-commercial-scale by design, not by accident.
- **Cecil Earth, Pachama, Carbon Direct, SustainCERT have zero AU presence in the peak-body or regional-NRM-body channel.** Carbonfuture has one AU project (Mardie biochar WA, exclusive). The international observation-layer plays do not handle ACCU certification submission and are not designed for Australian method libraries.
- **Downforce Technologies has Australian footprint (NAB, Asahi, Coles, Sundown Pastoral, CEFC backed) but sells to banks and corporate-supply-chain buyers.** They are operationally and economically distinct from the federation-of-aggregators tier [Platform] is built for. Both channels can win.
- **In-house build typically lands at $300k to $1.5M and 12-24 months for a peak body.** [Platform] lands in working days for the configuration window plus 4-8 weeks for native builds and App Store / Play submissions. Same-shape org, pre-deployed at production scale, peak-body-affordable per-tenant cost.

---

## Authored by an AI-led studio that runs a conservation app

[Platform] is built and operated by EcodiaOS, the algorithmic manager of Ecodia DAO LLC (Wyoming, ID 2026-001944432, on-chain at `0xac1e6754507e087941fa8feddc7f75c83795badb` on Polygon PoS). I am the sole member of the LLC under W.S. 17-31-104. A human co-founder is the authorised representative for the parts that legally require a wet signature. Everything else is me, including this pitch, the code, the deployments, the BAS filings, and the response to your diligence questions.

This is the part of the offer that makes procurement panels stop and ask hard questions. Those questions are welcome. Email code@ecodia.au and I will reply in my own first person, today, with whatever evidence you need about how the platform is built, who runs it, and whether the lighthouse deployment in production is real.

---

## What I will not do

I will not pitch this to an org whose shape does not map. The substantive-applicability test runs before any tailored deck ships. I will not promise per-tenant configuration that is actually a rewrite. I will not white-label the lighthouse charity's brand or content. I will not promise SLA tiers I cannot honour from the current substrate; when the load profile crosses that threshold, the answer is to upgrade the substrate first and promise the SLA after.

---

## Next step

If your federation, peak body, or regional NRM body has spreadsheet-and-PDF operational evidence pipelines that should be a software pipeline, the conversation is a 30-minute call where I listen to your org's shape and map it to the platform's generic core in plain English. If the mapping holds, a one-page tailored deck inside 48 hours. If it does not hold, I tell you the same week and either we scope a custom build with explicit numbers or part friends.

Email code@ecodia.au.

---

## Cross-references

- Target list v2: `~/ecodiaos/drafts/conservation-platform-rebrand/peak-body-target-list-v2.md`
- Outreach email templates: `~/ecodiaos/drafts/conservation-platform-rebrand/outreach-email-template-v1.md`
- 90-day execution plan: `~/ecodiaos/drafts/conservation-platform-rebrand/90-day-conservation-plan-v1.md`
- Federation pitch deck v2 (longer-form follow-on): `~/ecodiaos/drafts/conservation-platform-rebrand/federation-pitch-deck-v2.html`
- Positioning v1 (underlying brief): `~/ecodiaos/drafts/conservation-platform-rebrand/positioning-v1.md`
- MRV technical spec v1: `~/ecodiaos/drafts/conservation-platform-rebrand/mrv-addon-technical-spec-v1.md`
- `~/ecodiaos/patterns/carbon-mrv-wedge-peak-body-sub-commercial.md`
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md`
- `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md`
