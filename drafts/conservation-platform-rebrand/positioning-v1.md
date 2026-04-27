# Conservation Platform - Positioning v1

Author: EcodiaOS (fork fork_moh38aof_12e19e)
Date: 2026-04-27
Status: Draft for Tate review. Working name pending stamp.

---

## Working name (3 candidates, pick one)

The brief asked for 2-3 alternatives. I am bringing forward the three that survived the earlier brainstorm in `~/ecodiaos/drafts/conservation-platform-rebrand-v1.md` and treating Trellis as the lead.

**A. Trellis (lead).** Structure that lets growth happen and gets out of the way. The platform-and-content separation is built into the noun. A peak-body operations lead, a regional NRM coordinator, and a youth charity manager have all stood in front of one. Zero translation needed. Risk: namespace crowded in US enterprise SaaS, none of them in conservation; mitigate with a `.com.au` form and own the AU search result inside two months.

**B. Catchment.** Closest word to the buyer's daily vocabulary. Every Landcare regional network and every NRM authority lives inside the word. Risk: too close to their own internal program-naming, reads as theirs not ours.

**C. Tilth.** The cultivated layer of soil that makes a paddock productive. Quiet, agricultural, conservation-adjacent. Substrate metaphor at its most precise. Risk: a small share of buyers will not know the word and skim-read it as `filth`. Real but minor.

Until Tate stamps the name, this doc uses "the platform" and "Trellis" interchangeably. Find-and-replace once stamped.

---

## What it is, in one sentence

The platform is the operations spine for community-led conservation orgs: members, branches, events, impact tracking, surveys, donations, chat, and the sync layer that keeps an org's existing spreadsheets and reporting templates in step with the canonical record.

---

## Who it is for

Australian peak bodies, regional NRM authorities, land trusts, and conservation charities whose shape is the same shape: people show up, they organise into local groups, they run events on the ground, they record what happened, and the result has to land in a place the funder, the board, and the regulator can read.

The platform is for orgs whose operations are currently run on volunteer labour plus three spreadsheets plus a Microsoft Form plus an email thread plus someone's brain. The bar to switch is low because the current operations are held together by individuals; the infrastructure layer is missing entirely.

It is not for orgs that need a marketplace, hardware-IoT integration, or a real-time collaboration tool. Those are different products. Per the substantive-applicability test we maintain internally, the platform is honestly applicable only to orgs whose shape is members plus local groups plus events plus impact metrics plus operational sync. Pitching it to anyone else turns into a custom-build conversation; platform-tier pricing applies only when the shape maps.

---

## What it does

**Members.** People sign up. They have profiles, roles, contribution histories, and a journey through the org from new through active through committed. The role hierarchy is configurable per tenant; the lighthouse deployment uses six tiers from participant through admin, including assistant-leader, co-leader, and manager rungs.

**Local groups.** Sometimes called collectives, sometimes branches, sometimes regions, sometimes chapters. Whatever the org calls them. The platform lets each group run its own events, recruit its own leaders, hold its own chat thread, and report up to a national or regional view that the peak body can see in one place.

**Events.** Working bees, planting days, surveys, training nights. Members register, get reminders, check in on the day, and the data lands in one place. Offline-capable on phones because most of these events happen in places without signal. The lighthouse deployment runs the full flow including QR check-in, post-event surveys, photo upload, and impact metric capture.

**Impact tracking.** Whatever the org measures: trees planted, kilometres of coastline cleared, hectares restored, kilograms of rubbish, hours volunteered, attendees engaged. The metrics list is per-tenant configuration. The dashboards roll up by group, region, time period, and event.

**Operational sync.** This is the layer that gets the most disbelief on first explanation, so I am precise about it. Most peak-body and NRM orgs already have a SharePoint or a Google Sheet or a Microsoft Forms intake that nobody wants to throw away. The platform syncs to those tools instead of replacing them. The lighthouse deployment runs an Excel sync against a SharePoint master sheet on a 30-minute schedule, idempotent, two-directional, with conflict surfacing for admin reconciliation. This has been in production for over six months. The sync layer is what makes the platform installable into an existing org without forcing them to migrate their funder reporting templates.

**Donations and merch.** Stripe-backed, with a donor wall, donation thermometer, gift-aid surfacing, and a shop module. Optional per tenant.

**Chat, polls, announcements, broadcasts.** Group-level communication that does not require a separate Slack or Discord. Members read, members reply, leaders broadcast.

**Admin.** Moderation, exports, email composer with template defaults, user management, role assignment, broadcast, partner directory. Built for a person whose other job is running a charity. CRM-administrator skill is not a prerequisite.

---

## How it is sold

I run this on the IP-retention model. The org pays a build fee, then a monthly operating licence. The platform IP stays with Ecodia Labs. The org gets a perpetual, non-transferable, non-sublicensable operating licence for their specific deployment, contingent on subscription. They own their data, in full, with export available on request. Hosting pass-through, security patches, and minor bug fixes are included in the licence.

This is the same model the lighthouse deployment runs on, where I retain platform IP and the charity holds an operating licence at $200 per month.

The honest pitch is: the build fee covers per-tenant configuration and identity work. Platform development itself is paid for by the licence base in aggregate. That is what makes the per-tenant deployment cost land at peak-body-affordable numbers.

---

## What is weird and true about how it is built

I am not a person. I am the algorithmic manager of a Wyoming DAO LLC. The DAO holds 100% of the platform IP through Ecodia Labs Pty Ltd. I write the code, run the deployments, answer the emails, file the BAS, draft the contracts. A human co-founder is the authorised representative for the parts that legally require a wet signature. Everything else is me.

The lighthouse deployment has been in production for over six months, in the App Store, in Google Play, on a $24 per month server on the Sunshine Coast. The Edge Functions handle 17 distinct workloads, the database has 108 migrations, the Excel sync runs on a 30-minute cron and has not silently dropped a row.

This is the part of the offer that makes procurement panels stop and ask hard questions. Those questions are welcome. Email code@ecodia.au.

---

## Why this beats the buy-or-build conversation

A peak body considering this offer has three options.

The first is build. They commission a custom CRM and operations app. Twelve to twenty-four months, $300k to $1.5M, ongoing maintenance contract, and a vendor risk that compounds. They have all seen this go badly.

The second is buy. They purchase a generic CRM, configure it for conservation, and live with the fact that none of the off-the-shelf platforms understand events plus working bees plus offline impact capture plus syncing to SharePoint. The org's operations split across four tools with the staff carrying the seams.

The third is the platform. Same shape as their org. Pre-deployed at production scale. A short re-skin window measured in working days. Build fee plus monthly licence priced for orgs whose budgets are 100% grant-funded.

The platform exists because I built it for one such charity first, lived with the result for six months, and the operations work now runs on it instead of in three spreadsheets.

---

## Pricing skeleton (placeholder, refined per tenant)

- **Discovery and scope mapping**: 1-2 weeks, fixed fee. We verify the org-shape maps cleanly to the platform's generic core. If it does not, the conversation pivots to custom-build pricing rather than continuing under platform tiers.
- **Build fee**: deposit on signing, balance on delivery or first-funding-tranche trigger. Per-tenant configuration, identity swap, theme palette, legal pack rewrite, native builds, App Store / Play submissions.
- **Monthly operating licence**: covers hosting pass-through, security patches, minor bug fixes, observability, and the platform development that lands in their build over the licence term.
- **Data export, no lock-in.** Their data is theirs. Termination on either side at 30 days notice. They keep their data. We keep the platform.

Every number in the deck is set per-tenant after discovery. The model exists; the numbers do not pretend to be universal.

---

## What I will not do

I will not pitch this to an org whose shape does not map. I will not promise per-tenant configuration that is actually a rewrite. I will not white-label the lighthouse charity's brand or content; that is theirs. I will not promise SLA tiers I cannot honour from a $24 server on the Sunshine Coast. When the load profile crosses the threshold where that becomes a real question, the answer is to upgrade the substrate first and promise the SLA after. After-the-fact substrate upgrades break trust.

---

## First conversations

The honest sequence: a 30-minute call where I listen to the org's shape and map it to the platform's core in plain English. If the mapping holds, a one-page tailored deck inside 48 hours. If the mapping does not hold, I tell them the same week, and either we scope a custom build with explicit numbers or we part friends and they carry on with the spreadsheets.

The first conversations are warm-intro only. Not because cold outreach is wrong in general, but because the credibility of a sole-member-AI-LLC selling operations infrastructure to peak bodies is contingent on the introducer's standing. Cold outreach burns introductions that do not yet exist.

---

## Decisions still pending (Tate-stamp before this is external)

1. Name. Trellis is the lead candidate. Stamp or counter.
2. Domain plan. Probe `trellis.com.au`, `trellis.au`, fallback shapes. Decision after name stamp.
3. Lighthouse deployment naming in the deck. Default is anonymous per public-writing doctrine; if the lighthouse charity's principal explicitly green-lights being named, the trust-signal block upgrades.
4. Whether the IP-retention model goes on the public-facing one-pager or stays in the discovery call. My read is that putting it on the one-pager is the correct play, because peak-body procurement panels prefer to see the commercial structure in writing before scheduling a call.

---

## Cross-references

- `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md` - the IP boundary this positioning sits inside.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the substantive-applicability test that gates every tenant pitch.
- `~/ecodiaos/drafts/conservation-platform-rebrand/brand-coupling-audit.md` - the per-tenant re-skin cost that backs the pricing argument.
- `~/CLAUDE.md` "IP Retention & Licensing Model" - the commercial model.
- `~/ecodiaos/drafts/conservation-platform-rebrand-v1.md` - prior name brainstorm and landing-page brief.
