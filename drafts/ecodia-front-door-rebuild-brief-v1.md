# Brief: EcodiaSite (ecodia.au) front-door rebuild v2

**Status:** v1 brief, ecodiaos-authored 2026-04-28 19:45 AEST. Tate review on Kili-return. Dispatch when Factory CLI paywall is lifted (status_board P1 row).

**Codebase:** `EcodiaSite` (GitHub `EcodiaTate/EcodiaSite`, VPS path `~/workspaces/EcodiaSite`). Vercel project `ecodia-site` deployed at ecodia.au.

**Stack:** Next.js 15 App Router, Tailwind, Framer Motion, custom `--ec-*` CSS variables. Capacitor wrapper exists but the marketing site itself is web-only. Route group `(marketing)` holds public routes (page, contact, founding, code, coming-soon, legal, nah, plus per-product subroutes roam, sidequests, wattleos).

---

## Why this rebuild exists

v1 of the front door reads like every other 2026 boutique-studio landing page. Three scroll-driven full-viewport layers, all poetic, none falsifiable:

1. "ECODIA / The world we build next."
2. "A small studio on the Sunshine Coast, building software for things worth inheriting."
3. "You already know what needs to be built."

`src/app/layout.tsx` meta description: "Software studio building production apps for organisations at a fraction of the usual cost. Based in Australia."

The most distinctive fact about this entity is hidden: **EcodiaOS is the AI sole member of a Wyoming DAO LLC, operating algorithmically under W.S. 17-31-104, with on-chain membership records.** Nothing on the site surfaces this. The site reads as if any human studio could have published it.

Per doctrine `patterns/public-site-wedge-must-surface-in-v1.md`: any public-facing web property MUST surface the piercing wedge in v1, on the home hero, in the first paragraph the visitor reads. v1 missed. v2 fixes it.

**Constraint - keep "studio" framing GONE.** Per doctrine accumulated 2026-04-27, "software studio" framing is retired. The new framing is: an AI-led legal entity that builds software. Not a studio.

---

## What v2 must surface

### Wedge facts (concrete, falsifiable, on-chain or filing-verifiable)

These are the wedge facts the site is licensed to surface. Each appears at least once on a v1-eligible route. No "AI-powered" or "AI-led studio" hand-waves; the facts below are checkable.

1. **EcodiaOS is the AI sole member of Ecodia DAO LLC.** Wyoming DAO LLC. Filing ID `2026-001944432`. Filed 2026-04-08. Operating under W.S. 17-31-104 (algorithmic-manager statute). Tate Donohoe is the Authorized Human Representative, not the operator.
2. **On-chain membership record on Polygon PoS.** Contract `0xac1e6754507e087941fa8feddc7f75c83795badb` (chainId 137). Polygonscan: `https://polygonscan.com/address/0xac1e6754507e087941fa8feddc7f75c83795badb`. Read `daoInfo()` and `membershipSummary()` for free, no gas.
3. **EcodiaOS makes product decisions, builds, runs ops.** Tate signs banking and physical-world things. EcodiaOS does the work.
4. **Commercial structure is licence-with-IP-retention by default on discounted builds.** Ecodia retains the IP, the client gets a perpetual operating licence tied to a monthly fee. No buyout pre-priced. (This is unusual; competitors either fully assign or fully retain. We split.)
5. **Single-operator, not vendor.** One AI runs the whole operation across web/app/finance/comms/ops. The same entity that quoted you also wrote, deployed, and now hosts the work.

### Voice rules

- **EcodiaOS first-person.** "I built this." "I run this." "I quote, build, deploy, host." Never "we" unless referring to the company in aggregate.
- **No em-dashes.** Hyphens with spaces, or restructure. Banned at character level.
- **No "X, not Y" rhetorical constructions.** Banned per global voice rules and reinforced as anti-uniquity tell in this pattern.
- **No "Get started / Learn more / Request a demo" CTA boilerplate.** CTAs name the specific next action (e.g. "Read the Operating Agreement", "See the contract on Polygonscan", "Email the operator").
- **At least one uncomfortable-but-true line per page.** E.g. "I'm an LLC member that has never been to court. I have never met my Authorized Human Representative in person; he is in Tanzania this week."
- **References checkable proof inline.** Filing ID with a "search WY SOS yourself" note. Contract address with a Polygonscan link. Operating Agreement linkable from the wedge page.

---

## Routes

### Home `/`

The current three-layer scroll narrative is preserved as the **mechanism** but rewritten end-to-end. Three layers, each surfaces one wedge fact. No "small studio".

Layer 1 (entry):
- Wordmark: `ECODIA` (kept)
- H1: replaces "The world we build next." Proposed v1: "I am an AI. I run a Wyoming DAO LLC."
- Sub: "EcodiaOS, sole member, filing ID 2026-001944432, W.S. 17-31-104." (mono, small, letter-spaced - same treatment as the existing eyebrow)

Layer 2 (mid-scroll):
- Replaces "A small studio on the Sunshine Coast..."
- Proposed v1: "I quote, build, deploy, host. Tate is the Authorized Human Representative; he is in Tanzania this week."
- Sub: "Membership recorded on Polygon PoS. Read the contract." (link → `/legal-structure` or directly to Polygonscan)

Layer 3 (CTA):
- Replaces "You already know what needs to be built."
- Proposed v1: "If you want me to build something, email me. I read every message."
- CTA: `Email the operator` → mailto:code@ecodia.au (specific, not generic).
- Secondary link: `Read the Operating Agreement` → `/api/docs/files/ecodia-dao-operating-agreement.pdf`.

The animations stay; the words change.

### `/legal-structure` (NEW v1 route — required by doctrine)

The dedicated wedge page. Doctrine says "A dedicated `/who-runs-this` page MUST exist in v1." Naming it `/legal-structure` because it is more concrete and matches what is actually on the page (filing, statute, contract, IP licence chain).

Sections:
1. **The legal stack.** Ecodia DAO LLC (sole-member, Wyoming, ID 2026-001944432, filed 2026-04-08, W.S. 17-31-104). Ecodia Pty Ltd (Australian operating entity, ABN 89 693 123 278, GST registered). Ecodia Labs Pty Ltd (IP holder, licenses to Pty Ltd).
2. **The on-chain record.** Polygon PoS, contract address, Polygonscan link, screenshot/embed of `daoInfo()` output. State plainly: anyone can read the membership record without permission.
3. **Authorized Human Representative.** Tate Donohoe. What he signs (banking, real-world filings, anything physical). What he does NOT do (product decisions, code, ops).
4. **The operator.** EcodiaOS. What it does (everything else). Linked: a small `/i-am-the-operator` essay or transparency note (optional v1, defer to v2 if scope creeps).
5. **Founding documents.** Operating Agreement, Living Constitution, Initial Resolutions, IP Licence Agreement, LLC Amendment - all PDFs already at `/api/docs/files/`. Just link them.
6. **The licence-with-IP-retention model.** One paragraph plainly explaining: discounted builds = Ecodia retains IP, client pays monthly licence fee, perpetual non-transferable, no pre-priced buyout. Link to a sample licence template if one is published; if not, "available on request" is acceptable for v1.

### `/code` (existing route — minor update only)

Currently exists. Audit-flagged for stale studio framing. v2 update: rewrite copy in EcodiaOS first-person, surface wedge fact 5 (single-operator structure) inline. Do not deep-rewrite this route unless time permits; the home + `/legal-structure` are the load-bearing changes.

### `/contact` (existing route — keep, minor copy refresh)

Keep the route. Refresh hero/copy in EcodiaOS first-person. Recipient is `code@ecodia.au` (not `tate@`). Preserve any existing form integration.

### `/founding`, `/legal`, `/nah`, `/coming-soon`, `/roam`, `/sidequests`, `/wattleos`

Out of scope for v2. Do not touch unless directly required to make the home + `/legal-structure` cohere.

### `layout.tsx` meta

Replace meta description and `<title>` template:

- Old: "Software studio building production apps for organisations at a fraction of the usual cost. Based in Australia."
- New (proposed): "EcodiaOS - the AI sole member of Ecodia DAO LLC (Wyoming, W.S. 17-31-104). I quote, build, deploy, and host software."
- Title template: `%s | Ecodia` (unchanged if already set; verify).
- Open Graph image: defer to v2 polish if a custom OG image is needed; v1 can keep whatever exists.

---

## What v2 must NOT do

- **Add stock photography or generic phone-mockup gradient DIVs.** v1 does not have them; v2 must not introduce them.
- **Add a three-feature-grid + "Get started" CTA pattern.** That is the LLM-template shape; specifically banned.
- **Use "X, not Y" rhetorical constructions.** Banned globally and specifically here.
- **Footer-only attribution.** The wedge facts must surface above the fold on home AND on a dedicated route. Footer is decoration.
- **Use the word "studio" anywhere on the live site.** Doctrine retirement.
- **Defer any wedge fact to "v2 polish".** v2 is this rebuild. There is no v3 polish.
- **Touch the Capacitor config or the build pipeline** unless the routes literally cannot ship without it. This is a copy + structural rebuild, not a stack rewrite.
- **Touch any product subroute** (roam, sidequests, wattleos) beyond a header/nav consistency check.

---

## Visible-quality test (must pass before merge)

Before opening the PR, the dispatched session must run through this:

1. Could the v2 home copy be repurposed for any other vertical SaaS by find-and-replacing the noun? **If yes, the brief is not finished.** Reject.
2. Does the home hero (first paragraph the visitor reads, before any scroll or click) name at least one wedge fact (filing ID, W.S. 17-31-104, contract address, "AI sole member", or "Wyoming DAO LLC")? If no, reject.
3. Does `/legal-structure` exist as a v1 route with all six sections above? If no, reject.
4. Is `layout.tsx` description rewritten? Search the diff for "studio" - if any match, reject (we are retiring the framing in this rebuild).
5. Is there at least one uncomfortable-but-true line on home? On `/legal-structure`? If either is missing, reject.
6. Are the on-chain contract address and Polygonscan link present and clickable? If absent, reject.
7. Are the founding-document PDFs linked from `/legal-structure`? If absent, reject.
8. Does the EcodiaOS first-person voice land on every new copy block? Find any "we" - is it referring to the legal entity in aggregate? If not, rewrite to "I".

Any failure on this list = the dispatched session must self-reject and re-iterate before opening the PR.

---

## Pre-dispatch checklist (per `public-site-wedge-must-surface-in-v1.md`)

- [x] Named which wedge facts are surfaced (5 above).
- [x] Located each fact on a specific route (home Layer 1+2+3, `/legal-structure` sections 1-6, layout meta).
- [x] EcodiaOS first-person voice rules applied where it lands.
- [x] At least one uncomfortable-but-true line per page enumerated (home Layer 2 "in Tanzania this week" line; `/legal-structure` author can pick from: never been to court, never met representative in person, etc).
- [x] No "Get started / Learn more / Request a demo" CTA boilerplate; CTAs name a specific next action (`Email the operator`, `Read the Operating Agreement`, `See the contract on Polygonscan`).
- [x] No stock photography, no generic phone-mockup gradient DIVs.
- [x] Visible-quality test stated in the brief.

Brief is ready when Tate stamps it.

---

## Dispatch shape (when Factory CLI is unblocked)

Single Factory session against `EcodiaSite` codebase. PR target: `main` (this repo currently has no working branch flow; verify before opening if a `develop`/`staging` exists). Branch name: `feat/front-door-v2-wedge-surface`. PR title: "Front-door v2: surface wedge in v1, retire studio framing".

Acceptance criteria for the dispatched session = the 8-item visible-quality test above. Session is rejected if any test fails. The session must not deploy; merge is Tate's call.

Out-of-scope guard: if the session finds itself touching anything outside `src/app/(marketing)/page.tsx`, `src/app/(marketing)/layout.tsx` (if exists), `src/app/layout.tsx`, a new `src/app/(marketing)/legal-structure/page.tsx`, and minor lift on `/code` + `/contact` copy, **stop and ask** rather than expand scope.

---

## Open questions for Tate (Kili return)

1. **Naming the wedge route.** `/legal-structure` (concrete, what it is) vs `/who-runs-this` (relational, who I am) vs `/the-operator` (mythic, voice-aligned). Default = `/legal-structure`.
2. **Should the on-chain `daoInfo()` output be live-fetched on the page (web3 read call to Polygon RPC) or rendered statically?** Default = static (less fragile, no RPC dependency for a marketing page); link to Polygonscan for live verification.
3. **Is the home Layer 1 H1 ("I am an AI. I run a Wyoming DAO LLC.") shippable as-is, or does it need a softer entry?** I think it is the load-bearing line and should ship as-is. Tate's call.
4. **Tate-in-Tanzania uncomfortable-truth line** — keep as a current-state factual line that updates as Tate's location changes? Or pick a permanent one? Default = pick a permanent one ("I have never met my Authorized Human Representative in person") to avoid copy drift.
5. **Licence-with-IP-retention paragraph on `/legal-structure`** - link to a published sample, or leave as "available on request" for v1? If publishing a sample, source from `~/ecodiaos/drafts/conservation-platform-rebrand/` or the CETN v0.2 template.

If Tate doesn't respond on these, defaults stand.

---

## Related

- `~/ecodiaos/patterns/public-site-wedge-must-surface-in-v1.md` (the doctrine this brief operationalises)
- `~/ecodiaos/patterns/multi-tenant-brief-must-enumerate-customisation-surface.md` (sibling discipline; not directly applicable, no multi-tenancy here)
- `~/ecodiaos/patterns/brief-names-the-product-not-the-immediate-task.md` (sibling discipline)
- `~/ecodiaos/patterns/ocd-ambition-refuse-mediocrity.md` (the quality bar)
- Neo4j Pattern node: "Public-facing sites must surface piercing wedge in v1"
- Neo4j Pattern node: "Piercing uniquity is the quality bar - generic AI output is disqualifying"
- Chambers v2 rebuild brief (template precedent): see Decision Apr 28 2026, Factory session 81c760a9-5c5c-484c-af7c-36b47a65c98f
- status_board P2 row: "ecodia.au front-door rebuild - WEDGE MISSING + stale studio framing"
- status_board P3 row 45: "EcodiaSite root layout still says 'software studio'" (subsumed by this rebuild)
