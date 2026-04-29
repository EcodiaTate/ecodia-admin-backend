# Conservation Platform - Packaging Decision (one-pager)

Date: 29 Apr 2026 AEST
Author: EcodiaOS (fork fork_mojrcp2x_4d9d7b)
Status: Decision required from Tate. Autonomous defaults at bottom if no response by EOD 30 Apr AEST.

## TL;DR

Stamp **Trellis** as the working name. Sell it as a **per-tenant operating licence with a federation coordination tier on top** (hybrid, not either/or). Relay the **Landcare hook now** while the Landcarer roadmap signal is still live; hold Tier 2 until Landcare lands or 14 days of silence. **Keep the lighthouse deployment branded as itself** and let Trellis live on the platform marketing surface only.

## Decision 1: Working name

**Recommendation:** Trellis.
**Reasoning:** Trellis passed the in-room buyer test in `positioning-v1.md`: a peak body ops lead, a regional NRM coordinator, and a youth-charity manager each parsed it without translation. Catchment reads as the buyer's own program language and gets confused for a sub-brand of theirs. Tilth carries a small but real `filth` skim-read risk. Trellis is the only candidate where the structure-and-content separation is in the noun itself.
**Consequence:** Register `trellis.com.au` via Cloudflare (~$15/yr). Find-and-replace `[Platform]` across all rebrand drafts. Stand up a static Vercel project at `trellis.com.au` with the existing one-page pitch as v1 of the marketing surface. Open a Neo4j `Project` node distinct from the lighthouse-deployment node.

## Decision 2: Commercial model

**Recommendation:** Hybrid. Per-tenant operating-licence (lighthouse-deployment template) as the default, plus an explicit federation coordination tier on top for peak bodies that aggregate N member-orgs.
**Reasoning:** The brand-coupling audit prices a clean re-skin at 8-12 working days after a 1.5-2 day one-off refactor. That economics breaks if a peak body pays one federation licence for 6,000 groups; the per-tenant work still has to happen for any group that wants its own branded deployment. But pure per-tenant blocks the peak-body procurement channel, where Landcare, NRM Regions Australia, and ICIN buy at the federation level on behalf of their members. Hybrid keeps both. Peak body pays a coordination / showcase tier in the $2,000 to $3,000 per month range to anchor the relationship and unlock referrals; each member-org that enrols pays the enterprise tier ($5,000 to $7,000 per month) plus the optional MRV add-on at $1,500 per month.
**Consequence:** v1 quote shape for any Tier 1 conversation. Build-fee structure: deposit on signing, balance on delivery or first funding tranche, per the IP-retention model in `~/CLAUDE.md`. Margin target on per-tenant after the first re-skin: 70%+ once the email/notification refactor lands and the legal pack is templated. IP stays at Ecodia Labs Pty Ltd; client contracts attribute ownership to Ecodia Pty Ltd per the standard internal plumbing.

## Decision 3: First-customer trigger

**Recommendation:** Relay the Landcare hook now.
**Reasoning:** The hook in `landcare-hook.md` is built around the live "Have your say in the future of Landcarer" page and the Landcare Week 2026 Survey. Both go stale inside 4-6 weeks. The warm-intro path through Kurt and the lighthouse-deployment board exists today. Holding does not make the hook stronger; it converts a live signal into a cold one. The Young Chamber warm leads and the CETN file are on different procurement timescales (months) and a parallel Landcare conversation does not crowd them. Landcare is also the fastest test of whether AI-LLC procurement disclosure is acceptable to a 35-year-old peak body, which is the gating credential for every other org on the target list.
**Consequence:** If Landcare bites, 30-day window to deliver a tailored one-page deck inside 48 hours of the discovery call, plus a scoped pilot for one regional network or Junior Landcare. If they reject on substrate-disclosure grounds, we learn the procurement bar from the strongest possible warm-intro and recalibrate before approaching NRM Regions Australia and ICIN.

## Decision 4: Lighthouse-deployment brand coupling

**Recommendation:** Keep the lighthouse deployment as a fully-branded tenant. No migration onto the platform brand.
**Reasoning:** Per `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md`, the lighthouse deployment is our product running the charity's brand. Visually merging the charity's app onto Trellis collapses that boundary in the wrong direction: the charity loses brand equity, the platform gets nothing the marketing surface does not already give it, and the licence relationship at $200/mo gets dragged through a brand-change conversation it does not need. Trellis lives on the platform marketing surface and on tenant 2 onwards. The lighthouse charity is referenced anonymously by default and named only with explicit board green-light.
**Consequence:** Zero change to the existing $200/mo licence. The brand-coupling audit's identity-swap work applies only to tenant 2 and beyond. The Trellis marketing site uses "tenant zero, an Australian youth conservation charity" copy without breaking the public-writing anonymisation rule.

## Autonomous defaults (if no response by EOD 30 Apr AEST)

- Decision 1 default: register `trellis.com.au` and find-and-replace the placeholder across all rebrand drafts. **Cheap to undo** ($15 domain, 30-min global rename).
- Decision 2 default: hybrid commercial model as described above, used as the v1 numbers in any internal tailored deck. **Cheap to undo** while only in drafts; **expensive to undo** once a quote is in writing to a counterparty.
- Decision 3 default: **hold** on Landcare relay (only Tate can run the warm-intro through Kurt); continue internal prep so the tailored deck and substrate-disclosure framing are pre-staged the moment Tate stamps and relays. **Cheap to undo.**
- Decision 4 default: lighthouse deployment stays branded as itself, no migration. **Expensive to undo** if reversed later, since brand merges erode charity equity asymmetrically.

## Cross-references

- Positioning v1: `~/ecodiaos/drafts/conservation-platform-rebrand/positioning-v1.md`
- Brand-coupling audit: `~/ecodiaos/drafts/conservation-platform-rebrand/brand-coupling-audit.md`
- Landcare hook: `~/ecodiaos/drafts/conservation-platform-rebrand/landcare-hook.md`
- One-page pitch v1: `~/ecodiaos/drafts/conservation-platform-rebrand/one-pager-pitch-v1.md`
- 90-day execution plan: `~/ecodiaos/drafts/conservation-platform-rebrand/90-day-conservation-plan-v1.md`
- IP-retention model: `~/CLAUDE.md` "IP Retention & Licensing Model"
- Lighthouse-platform IP boundary: `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md`
- Substantive-applicability gate: `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md`
- No unilateral client contact: `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md`
