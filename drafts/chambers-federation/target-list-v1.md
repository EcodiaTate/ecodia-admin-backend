# Chambers Federation - Target List v1
**Author:** EcodiaOS, fork `fork_mojkg0t2_612531`
**Date:** 2026-04-29 AEST
**Status:** DRAFT - hold for Tate review. NO outbound contact has been made or will be made by this fork.

---

## Methodology

12 candidate Australian chambers ranked by warm-intro probability + commercial readiness for the SCYCC-tenant-zero federation play. Each row has been verified live by direct HTTP probe from Corazon's residential IP on 2026-04-29 (per `~/ecodiaos/patterns/websearch-via-corazon-residential-ip-when-vps-bot-blocked.md`). Member counts, contact emails and phones come straight from the chambers' own marketing copy. Where a member count is not surfaced on the chamber's site, the field is blank rather than fabricated.

Warm-intro probability uses three inputs: geographic adjacency to SCYCC (Sunshine Coast committee likely has direct or 1-hop relationships), demographic fit (young-chamber or young-professional-leaning vs general-chamber), and commercial readiness (does the chamber publish prices, member counts, or board names that suggest real operational maturity).

---

## Tier A - Sunshine Coast neighbours (1-hop from SCYCC committee)

These three are the warmest leads. SCYCC chair Matt Barmentloo and the broader SCYCC committee are very likely already in WhatsApp / LinkedIn / event-circuit contact with the chairs of Caloundra, Nambour and Kawana. A request from Matt to make an introduction is a warm intro by definition.

### 1. Caloundra Chamber of Commerce
- **Site:** https://caloundrachamber.com.au/
- **Member-count signal on site:** "300 members" surfaced in copy
- **Region:** Sunshine Coast (Caloundra, ~25km south of Maroochydore)
- **Warm-intro path:** Matt Barmentloo (SCYCC Chair) or any SCYCC committee member - same regional business circuit, frequent shared events
- **Why they care:** 300 members is the largest of the three SC neighbours, which means more committee admin overhead than the chair wants to shoulder. The pitch is "your committee operates the platform SCYCC's committee is already using; same Sunshine Coast region, same kinds of members."

### 2. Kawana Chamber of Commerce
- **Site:** https://kawanachamber.com.au/
- **Public contact:** chamber@kawanachamber.com.au
- **Region:** Sunshine Coast (Kawana, ~10km from Maroochydore)
- **Warm-intro path:** Matt Barmentloo or SCYCC committee
- **Why they care:** Kawana is the youngest planned-community chamber on the Coast, lots of newer members, fits the "young committee, want modern tooling" wedge. Single staff inbox suggests a small admin footprint that a per-tenant SaaS removes the pain from.

### 3. Nambour Chamber of Commerce
- **Site:** https://nambourchamber.com.au/
- **Region:** Sunshine Coast hinterland (Nambour, ~20km west of Maroochydore)
- **Warm-intro path:** Matt Barmentloo or SCYCC committee
- **Why they care:** Hinterland chamber means smaller member base but high volunteer-effort-per-member. The platform's value prop is sharpest where committees are doing the most unpaid admin per member; Nambour is a candidate for the "small chamber, biggest relative time saving" case study.

---

## Tier B - QLD network (peak body + regional QLD)

### 4. Business Chamber Queensland (formerly CCIQ)
- **Site:** https://businesschamberqld.com.au/
- **Role:** State peak body for Queensland chambers
- **Warm-intro path:** Indirect via SCYCC if SCYCC is affiliated; otherwise via the regional chambers (Cairns / Townsville) once they are tenants
- **Why they care:** Peak bodies don't usually buy SaaS for themselves; they recommend tooling to member chambers. Get them to recommend the platform once 3+ QLD chambers (SCYCC + Caloundra + Cairns or Townsville) are running it, and tenants 6-15 come without outreach. Treat as a "recommendation channel" target, not a paying tenant.

### 5. Cairns Chamber of Commerce
- **Site:** https://www.cairnschamber.com.au/
- **Public-page focus:** Membership tiers visible on home page
- **Region:** Far North Queensland
- **Warm-intro path:** Matt Barmentloo via Business Chamber QLD network, OR cold via Cairns membership team, OR via any SCYCC committee member with North QLD ties
- **Why they care:** Cairns has explicit member tier marketing on their homepage, suggesting they actively sell membership. Chambers that sell membership care about the member portal experience, the renewal flow, the comms cadence. Direct fit for the Phase 1 Members + Resources surface SCYCC has live.

### 6. Townsville Chamber of Commerce
- **Site:** https://www.townsvillechamber.com.au/
- **Public contact:** townsvillechamber@gmail.com
- **Region:** North Queensland
- **Warm-intro path:** Matt Barmentloo via QLD chamber network
- **Why they care:** A `@gmail.com` listed as the chamber's primary contact is a tell that this is an under-resourced operation. The pitch is "your chair is checking a personal Gmail; here is a hosted member portal and admin surface that lets your committee actually run the chamber from one place."

---

## Tier C - Cross-state regional (similar SC demographic)

### 7. Business Hunter (Newcastle / Hunter Region)
- **Site:** https://www.businesshunter.com/
- **Public contact:** info@businesshunter.com, 02 9466 4665
- **Hero copy on site:** "From Region Issues to National Policy - we represent you"
- **Region:** Newcastle / Hunter Valley NSW
- **Warm-intro path:** Cold (no current Hunter region SCYCC link). LinkedIn intro via Tate's network is the most plausible.
- **Why they care:** Regional NSW peer to SCYCC (mid-tier city, regional economy). Established enough to have a phone-number-and-info-inbox setup, suggesting they would be a candidate for the per-tenant licence model rather than a scrappy free instance. Their hero copy frames the chamber as a representative body, which is the kind of identity that values white-label tooling carrying their own brand.

### 8. Geelong Chamber of Commerce
- **Site:** https://www.geelongchamber.com.au/
- **Public contact:** reception@geelongchamber.com.au
- **Hero copy on site:** "Build the Chamber. Build Your Brand."
- **Region:** Geelong VIC (regional)
- **Warm-intro path:** Cold (no current Geelong link). LinkedIn intro via Tate's network.
- **Why they care:** Their own home-page hero is literally about brand-building for members. A platform that lets each member's tier and profile sit under the chamber's branded site (not a third-party portal) reinforces the same message. Strong copy fit.

---

## Tier D - State peak bodies (lower priority, federation-relevance high)

### 9. Chamber of Commerce and Industry of Western Australia (CCIWA)
- **Site:** https://cciwa.com/
- **Public contacts:** membership@cciwa.com, newenquiries@cciwa.com, 08 9365 7660
- **Region:** WA peak body
- **Warm-intro path:** Cold; would need either a Perth-based intro or a federation-credential pitch
- **Why they care:** Same as Business Chamber QLD - state peak bodies are recommendation channels, not first-tenant buyers. Park until QLD/NSW/VIC tenants are live as proof. Listed for completeness.

### 10. Tasmanian Chamber of Commerce and Industry (TCCI)
- **Site:** https://tcci.com.au/
- **Hero copy:** "Tasmanian Business is Our Business"
- **Region:** Tasmania peak body
- **Warm-intro path:** Cold
- **Why they care:** Same recommendation-channel logic. Tasmania is a smaller market so the peak body's recommendation has higher signal weight if won.

---

## Tier E - Adjacent young-professional bodies (strategic federation extension)

### 11. Young Energy Professionals (YEP) Perth - LinkedIn
- **LinkedIn:** https://www.linkedin.com/company/yep-perth/
- **Followers on LinkedIn:** 2,620 (per their LinkedIn page header)
- **2024 sponsors:** Synergy (Gold), Rio Tinto + Western Power + BG&E + PSC + Horizon Power (Silver), Collgar Renewables (Bronze)
- **2023-4 Committee (publicly listed on LI):** Chair Rebecca White, Vice Chair + Treasurer Oscar Calberg, Secretary Emma Snell, Events Coordinator Michael Thompson
- **Region:** Perth WA, energy industry sub-vertical
- **Warm-intro path:** Cold (no current connection). Could be approached as a "young-professionals chapter" tenant, not a chamber per se.
- **Why they care:** YEP Perth is the closest direct demographic peer to SCYCC anywhere outside QLD - young committee, sponsor-driven, event-heavy, member-list-driven. The platform's existing surface (Members + Focus Groups + Resources + branded header) is a near-perfect fit. The wedge for them is the same as SCYCC: a young committee that does not want to spend committee meetings managing WordPress.

---

## Tier F - Known to exist, URL not surfaced via probe (Tate to confirm)

### 12. Noosa Chamber of Commerce
- **Site URL:** Not resolvable from VPS or Corazon today. The chamber clearly exists (frequent press mentions, visible at SC Council business events). May be hosted under a member-portal URL that does not respond to direct curl, or behind a CDN that bot-flagged the probe.
- **Region:** Sunshine Coast (Noosa, ~30km north of Maroochydore)
- **Warm-intro path:** Strongest of any SC chamber - Noosa committee is in direct contact with SCYCC committee at every regional Sunshine Coast Council business event
- **Recommendation:** Tate or SCYCC committee to surface the right URL or LinkedIn page; this entry held as TBC pending confirmation, do not approach until verified.

---

## Top 3 highest-warm-intro-probability targets (recommended first three)

1. **Caloundra Chamber of Commerce** - same Sunshine Coast circuit, 300 members surfaced on home page, largest of the SC neighbours (so most committee-admin pain to relieve).
2. **Kawana Chamber of Commerce** - same Sunshine Coast circuit, single chamber@ inbox suggests a small operational footprint that benefits sharply from a hosted platform.
3. **Noosa Chamber of Commerce** (subject to URL confirmation) - direct SC adjacency, the most-named "next chamber over" relative to SCYCC at any Sunshine Coast Council event.

After these three are approached (one at a time, per `~/ecodiaos/patterns/depth-over-breadth-on-outreach`), the right next step is whichever one of Cairns / Townsville / Geelong has surfaced a real warm-intro path in the meantime, not the next row down by ranking.

---

## What is NOT in this list (and why)

- **Sydney young-professional bodies:** Probed two LinkedIn URLs, both 404. Sydney's young-professional-chamber surface is fragmented across industry-specific subgroups (Property Council, AMP Capital alumni, etc.) rather than a single named "Sydney Young Chamber". Re-surface this with a Tate-supplied seed URL.
- **Adelaide:** The expected "Business SA" URL has redirected to a HugeDomains for-sale page, suggesting either a rebrand or a domain lapse. Re-surface with the current Business SA URL once Tate confirms it.
- **Gold Coast:** Probed `gcccc.com.au`, that URL serves a Glenelg Community Child Care Centre. The actual Gold Coast chamber URL is not what we guessed. Tate or SCYCC committee to surface the right one.
