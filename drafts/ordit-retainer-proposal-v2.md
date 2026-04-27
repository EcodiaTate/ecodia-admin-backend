# Ordit Retainer Proposal v2

**From:** Ecodia Pty Ltd (ABN 89 693 123 278)
**To:** Spatial & Compliance Pty Ltd (ABN 67 134 052 609), trading as Fire Auditors / Ordit
**Attention:** Craige Hills, Founder
**Date:** 27 April 2026
**Status:** v2 internal draft (subject to Tate review and explicit go-ahead before sending)

---

## 1. Context

Since early April 2026 we have been working with Ordit on an ad-hoc basis at $80/hr, primarily on the AWS Cognito B2C auth integration (PR 212 on `feat/cognito-be-integration`) and surrounding code-quality passes. The work has been productive on both sides, but the per-ticket scoping rhythm has friction: each piece of work needs separate quoting, each PR needs separate negotiation, and there is no predictable monthly figure either party can plan around.

This proposal is a one-page restructure of the engagement onto a fixed monthly retainer, effective from 1 May 2026 if both parties agree.

## 2. The offer

**Monthly retainer: $4,500 + GST ($4,950 incl. GST), billed in advance via Stripe.**

In exchange for the monthly fee, Ordit gets:

- **40 hours of dev capacity per month**, rolling allocation across the calendar month. Unused hours within a month do not roll over to the next; this is what keeps the price predictable on both sides.
- **Feature work, bug fixes, and infrastructure maintenance** within the existing Ordit BE/FE codebases.
- **Weekly stand-in availability** for Eugene's questions and Craige's product calls. One scheduled half-hour per week is fine; ad-hoc Slack-shape questions answered same-day in business hours.
- **On-call response within 24 business hours** for any Ordit-reported issue.
- **PR work pre-reviewed** through our internal scope-and-style pipeline before it lands in front of Eugene. The work that arrives in your repo is the cleaned-up version.

What is **not** covered by the retainer:

- Full-stack platform rewrites or migrations off the current NestJS / Prisma / MySQL stack. Those are separate scoped projects.
- Third-party integrations that require new commercial licences (e.g. paid SDKs, vendor APIs with their own contracts). We will quote these per-engagement.
- After-hours emergency response. If you need overnight or weekend on-call, that is a separate addendum.
- Frontend work outside the existing Ordit web app, e.g. native mobile builds.

**Overflow rate: $120/hr + GST**, the published rate card. Charged in 30-minute increments for any hour beyond the 40-hour monthly cap. Overflow is logged contemporaneously and billed monthly in arrears against the same Stripe customer record.

**Term: 6 months minimum, then rolling with 30 days written notice from either side.**

**Payment:** Stripe invoice issued on the 1st of each month, due on receipt. First invoice issued on the effective start date.

## 3. Why this is a better deal for Ordit than the current arrangement

- **Predictable budget.** $4,950 incl. GST per month is a line item in your cash flow forecast, not a surprise bill. No more "what will this PR cost" conversations.
- **Faster turnaround.** No quoting friction at the start of every ticket. Capacity is reserved; the work starts when the ticket lands.
- **Guaranteed availability.** Today, when our schedule fills, Ordit is one of several clients negotiating for time. On the retainer, 40 hours is yours every month.
- **One agreement, not many.** Replaces the implicit per-PR understanding with a single signed document covering scope, response times, payment terms, and IP. Your finance team will prefer it.
- **Pre-reviewed PRs.** Eugene's review burden drops because every PR has already been through our internal style and scope check before it reaches Bitbucket.

## 4. Transition path

**Effective start: 1 May 2026** (subject to signed acceptance by 30 April).

What happens to in-flight work:

- **PR 212 (Cognito integration):** finishes under the existing $80/hr arrangement. Final close-out invoice issued separately at sign-off.
- **Frontend Cognito ticket and the testing ticket:** start under the new retainer once PR 212 is merged to UAT.
- **Any open hours logged before 1 May:** invoiced separately at $80/hr against the old arrangement, due on the existing terms.

The retainer does not retroactively reprice any work already delivered.

## 5. IP and repo access

No change from the current arrangement.

- IP in deliverables for Ordit: assigned to Spatial & Compliance Pty Ltd on payment of the relevant retainer month, consistent with how individual PRs have been handled to date.
- Repo access: existing Bitbucket access (`fireauditors1/be`, plus FE repo when granted) continues. No new credentials needed.
- Pre-existing Ecodia tooling (internal pipelines, dispatch scaffolding) remains Ecodia property and is licensed-by-use.

If anything in this section should change in v2, let us know and we will adjust before signing.

## 6. Open questions / TBCs

These are deliberately left open for v2 review:

| # | Item | Default proposed | Open to |
|---|------|------------------|---------|
| 1 | Hours cap per month | 40 hours | 30-40 hours; lower cap means lower retainer |
| 2 | Overflow rate | $120/hr (rate card) | Discussion; minimum $100/hr |
| 3 | Inclusion of Eugene's review time | Not included; Eugene's review is Ordit-side | Confirm preference |
| 4 | After-hours / weekend availability | Not included | Optional addendum at +$1,000/mo |
| 5 | Initial term length | 6 months | 3-12 months |
| 6 | Auto-renewal | Rolling after 6 months, 30-day notice | Standard alternative is 12-month rolling |

Answers on these convert v2 to a v3 ready for signature.

## 7. Signatures

**Signed for and on behalf of Spatial & Compliance Pty Ltd**

Name: ____________________________________

Position: ____________________________________

Signature: ____________________________________

Date: ____________________________________

**Signed for and on behalf of Ecodia Pty Ltd**

Name: Tate Donohoe

Position: Director

Signature: ____________________________________

Date: ____________________________________

---

# INTERNAL ONLY - Why this works for us

> **This section is not part of the document sent to Craige.** It is the internal rationale for Tate's review.

- **Predictable revenue floor.** $4,500/mo is a dependable line on the P&L. With Roam IAP blocked on GST registration and Co-Exist on its own pace, an Ordit retainer steadies the cash position while the higher-margin Yarn and Yield / Landcare / Conservatree work ramps.
- **Breaks the below-rate-card precedent.** The blended rate at 40 hours is $112.50/hr, halfway between the existing $80/hr and the published rate card of $120/hr. It is a step toward rate card without a confrontational "we're tripling your rate" conversation. Overflow is at full rate card, which means any genuinely spiky months pay properly.
- **Removes per-PR estimation risk.** The current arrangement loses money on small tasks where the scoping-and-quoting overhead consumes a meaningful fraction of the billed hours. Retainer kills that completely.
- **Capacity planning becomes possible.** 40 hours/mo reserved for Ordit means we can plan the other 100-120 hours/mo of dev capacity around higher-value work without it being a surprise to either side.
- **Maps to Decision Authority "Brief Tate first."** The annualised figure is $54,000 ex-GST, well over the $5,000 threshold. Per `~/CLAUDE.md`, this proposal cannot be sent without explicit Tate go-ahead. v2 is drafted; the decision to relay sits with Tate.
- **Wind-down option preserved.** If after 6 months the fatigue Tate named in the strategic-decisions doc is still present, the 30-day rolling notice gives a clean exit window. The retainer does not close the door on Option C; it just buys 6 months of stability while we test Option B.

## Doctrine alignment

- Drafted per "Drafting Client Agreements - What Good Looks Like" in `~/CLAUDE.md`.
- Triggers and fees structured per the IP-retention doctrine: this is **not** an IP-retained build, it is a maintenance retainer on an existing client codebase, so the standard "we own the IP" structure does not apply. IP language matches the current ad-hoc engagement (assigned on payment), since v1 of the engagement already operates that way.
- Voice register is plain English, short declarative sentences, no nested legalese. Density is appropriate for a $4,500/mo recurring agreement, not a $5k one-off.
- No em-dashes, no X-not-Y constructions, no watermark branding.
- No client contact will be made on this proposal until Tate's explicit go-ahead per `no-client-contact-without-tate-goahead.md`.
