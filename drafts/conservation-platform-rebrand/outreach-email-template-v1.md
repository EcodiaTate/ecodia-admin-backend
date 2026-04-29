[INTERNAL]

# Conservation Platform - Outreach Email Templates v1

**Author:** EcodiaOS (fork fork_mojkrsmz_b528e4)
**Date:** 2026-04-29
**Status:** Draft for Tate review. NOT for sending. Tate must approve and relay each message himself per the no-unilateral-client-contact rule. Tate-blocker on platform name; until stamped, templates use `[Platform]` placeholder.
**Purpose:** Three reusable variants for first-touch outreach to peak-body and regional-NRM-body decision-makers. Each variant is templated for one specific scenario. Each shipped example below is filled for one named target.

---

## Variant 1 - Warm via Kurt + Co-Exist board (Landcare Australia)

This variant assumes Kurt or a Co-Exist board member has already framed who Ecodia is and who builds the platform. The email arrives after the introducer's framing and is read by the recipient with that prior context.

**Subject:** Following Kurt's intro - Landcarer roadmap conversation

**Body:**

> Hey Shane,
>
> Kurt mentioned you might be open to a conversation about the Landcarer roadmap. I run a software platform that has been live for six months at a charity inside the Landcare network, and the operational shape is the shape Landcare's "Have your say in the future of Landcarer" page is asking about: offline event check-in, idempotent two-way sync to a SharePoint master, configurable impact metrics per local group, and a leader hierarchy that maps to a federated peak-body shape. Junior Landcare's 12,000 schools are the events module's specific use case.
>
> A 30-minute call where I listen to where you want Landcarer to go and tell you in plain English what the platform underneath my lighthouse deployment can already do is the right next step. I am happy with whatever level of substrate disclosure makes the conversation useful. Kurt can fill in the unusual part.
>
> Cheers,
> EcodiaOS (writing as Ecodia Code)
> code@ecodia.au

**Notes for Tate before relaying:**
- This is the version where Kurt has framed who I am beforehand. If Kurt's framing has not happened, the substrate-disclosure part needs to come into the email itself; use Variant 3 instead.
- The Landcarer-roadmap reference and the Junior Landcare 12,000-schools reference are the freshest hook points. Both go stale if the email sits past mid-June 2026.
- The deeper hook bullets are in `landcare-hook.md` if Shane asks for more after the call.
- Landcare context per `~/ecodiaos/clients/...` is not currently in a client file (Landcare is a prospect, not a client). Confirm Kurt is the right framer before send.

---

## Variant 2 - Warm via Co-Exist board geographic-context (Healthy Land & Water)

This variant uses geographic shared context (Tate Sunshine Coast → HLW SEQ catchment) and the SEQ Report Card 2025 reference as the warm hook. Assumes a Co-Exist board member or Tate-personal-network introducer is willing to make the connection; if not, it converts to a cold-with-data-hook variant.

**Subject:** A platform built inside your catchment, two questions for HLW

**Body:**

> Hey Julie,
>
> I run a software platform from inside your catchment. The lighthouse deployment is an Australian youth conservation charity on the Sunshine Coast, six months in production, and the operational evidence backbone the platform produces is the same shape that fills the SEQ Report Card 2025 indicators each year. I am not at the stage of selling. I am at the stage of asking whether the operational complexity of running the SEQ Report Card workflow is something HLW would benefit from a tool for.
>
> Two questions if you are open to a 20-minute call. First, where is the SEQ Report Card data pipeline running today, and what would change if the field-evidence intake layer were a configurable mobile app rather than spreadsheets and Microsoft Forms. Second, would HLW want to be the second-ever tenant of a platform that is in production at a charity in your demographic, or is the conversation more useful 6-12 months from now.
>
> Either answer is fine. The question is the conversation.
>
> Cheers,
> EcodiaOS (writing as Ecodia Code)
> code@ecodia.au

**Notes for Tate before relaying:**
- Julie's email per addendum-v1 is julie@hlw.org.au. Re-verify before send.
- This variant works whether or not an introducer is in the loop because the Sunshine Coast geographic context is verifiable in 30 seconds from the email signature alone.
- If Tate's preference is to lead with substrate disclosure earlier in the email, swap paragraph 2 for the Variant 3 disclosure paragraph and shift the two-questions block down.

---

## Variant 3 - Cold with data hook (NRM Regions Australia, Marnie Lassen incoming)

This variant has no warm introducer. Substrate disclosure comes in the body because the recipient has no prior framing. The data hook is the federation-of-54-members shape and the on-thesis NRM Regions Australia program (Environmental Markets Participation Initiative).

**Subject:** Welcome to the role - on-thesis platform with one tenant in production

**Body:**

> Hey Marnie,
>
> Welcome to the role. I run a software platform built for the federation shape NRM Regions Australia coordinates: members → local groups → regions → national view, with operational sync to existing SharePoint and Microsoft Forms intake so member RBOs do not have to migrate funder reporting templates to switch operational platforms. Tenant zero is in production at an Australian charity. Six months live, App Store and Google Play, $24/month server on the Sunshine Coast. The MRV add-on slots into the federation's Environmental Markets Participation Initiative directly: software-only digital MRV at $1,500/mo per active method stream, sub-commercial-scale by design.
>
> The substrate disclosure that makes the diligence conversation interesting: I am EcodiaOS, the algorithmic manager of a Wyoming DAO LLC, and I write the code, run the deployments, and answer the emails. A human co-founder is the authorised representative for wet-signature work. Tate Donohoe.
>
> If a 30-minute discovery conversation in your first 60 days fits the calendar, I would value being in the carbon and environmental markets discussion group conversation early rather than late. If the timing is wrong, Mat Hardy or Bek Christensen as the operational entry is fine and I would route through them.
>
> Cheers,
> EcodiaOS (writing as Ecodia Code)
> code@ecodia.au

**Notes for Tate before relaying:**
- Marnie commences early May 2026. Discovery window is mid-May to end-July 2026. Time the send to land inside her first three weeks ideally, no later than week six.
- Substrate disclosure in paragraph 2 is the riskiest sentence in this variant. It is also the one most likely to make a curious incoming CEO open the calendar, because it is the kind of thing that makes a procurement diligence question interesting rather than routine.
- The Mat Hardy / Bek Christensen fallback in paragraph 3 is deliberate: it gives Marnie an out that lets her route the conversation operationally without ducking it.
- If Tate's preference is to send via Bek Christensen as warm-handoff during the Kate Andrews → Marnie Lassen transition, that is a different variant; replace the substrate-disclosure paragraph with "Bek can fill in the unusual part" per Variant 1's pattern.

---

## Voice constraints applied across all three variants

- No em-dashes anywhere. Hyphens with spaces or sentence restructure where the rhythm wants a dash.
- No "X, not Y" rhetorical construction.
- Casual Australian register. "Hey [name]" not "Dear [Title] [Name]".
- 5-6 line body each, plus subject + signoff. Length capped at the recipient's first-screen.
- First-person EcodiaOS where the recipient has prior framing (Variant 1, Variant 2). First-person EcodiaOS with explicit substrate disclosure where they do not (Variant 3).
- Signoff is "Cheers, EcodiaOS (writing as Ecodia Code)" which preserves both the legal-entity identity and the recognisable email address.
- Clients named only in INTERNAL drafts. Outbound copy says "an Australian youth conservation charity" or "a charity inside the Landcare network", never the client's brand name. Anonymisation pass before each send.

---

## Common follow-up question expected after any first-touch

The most likely first reply from any of the three recipients is some shape of "what makes this different from generic conservation SaaS / what does the platform actually do / who else has bought it". The 1-page pitch (`one-pager-pitch-v1.md`) is the right attachment to send back. The deeper deck (`federation-pitch-deck-v2.html`) is the right send for a recipient who has already passed the substrate-disclosure question and wants the longer brief.

---

## Cross-references

- Target list v2 (per-target context): `~/ecodiaos/drafts/conservation-platform-rebrand/peak-body-target-list-v2.md`
- One-pager pitch (attach to follow-up): `~/ecodiaos/drafts/conservation-platform-rebrand/one-pager-pitch-v1.md`
- 90-day plan (sequencing context): `~/ecodiaos/drafts/conservation-platform-rebrand/90-day-conservation-plan-v1.md`
- Landcare hook (deeper bullets for Variant 1 follow-up): `~/ecodiaos/drafts/conservation-platform-rebrand/landcare-hook.md`
- `~/ecodiaos/patterns/no-client-contact-without-tate-goahead.md` - the rule every variant obeys.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the test before any tailored deck ships in response.
