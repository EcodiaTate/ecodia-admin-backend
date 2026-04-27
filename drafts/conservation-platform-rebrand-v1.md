# Conservation Platform Rebrand - v1

Author: EcodiaOS (fork fork_mogp2q9r_18d4d6)
Date: 2026-04-27
Status: Draft for Tate review. Not for external eyes until name decision is stamped.

This doc replaces the "conservation platform (working name pending)" placeholder used in all platform-tier external artefacts since the 2026-04-27 IP recalibration. Co-Exist remains Kurt's app and brand; this is the rebrand for the platform underneath that we license to other orgs.

---

## 1. Name brainstorm (18 candidates)

Categories: nature/biology metaphor, infrastructure metaphor, latin/scientific, plain-english operational, single-syllable punchy. No "AI", "Smart", "Pro", "Hub", "Cloud", or generic SaaS suffixes.

### Nature / biology metaphor

1. **Trellis** - the structure plants climb on. The trellis holds shape and gives direction; the plant does the growing. Cleanest possible platform-versus-content metaphor.
2. **Tilth** - the cultivated, friable layer of topsoil that makes a paddock productive. Quiet, agricultural, conservation-adjacent. Substrate for growth.
3. **Coppice** - a regenerative forestry technique where one stump regrows again and again. Same root, repeated yield. Maps to a platform serving many tenants from one core.
4. **Catchment** - the area whose water all collects in one place. Native AU conservation vocabulary. Federation metaphor built in.
5. **Tributary** - smaller flows feeding a larger system. Strong fit for a peak body federating local groups onto one substrate.
6. **Estuary** - confluence of river and sea. Multi-tenant convergence imagery.
7. **Murmur** - the collective coordination of a starling flock. Beautiful but ambiguous; better as a feature name than a brand.

### Infrastructure metaphor

8. **Bedrock** - the substrate beneath. Solid, but generic and likely contested in domain space.
9. **Levee** - infrastructure that lets a community work the land safely. AU coastal/flood lens. Strong but specific.
10. **Foundry** - where things are cast. Reads more "developer tools" than "conservation operations."
11. **Conduit** - a channel through which things flow. Plain operational register, slightly cold.

### Latin / scientific

12. **Phyla** - the biological classification above class. Multi-tenant federation hint. Slightly esoteric, intellectual register.
13. **Strata** - layers in geology. Calm, understated. Risk: feels like a real-estate or analytics brand.
14. **Census** - the formal count of a population. Operational and direct, but reads more government than charity.

### Plain-english operational

15. **Fieldbook** - the notebook a field worker carries. Humble, clearly conservation-coded, instantly readable.
16. **Tally** - what you have at the end of a working bee. Direct, modest, slightly playful. Risk: too thin for a platform brand.
17. **Roster** - who is doing what when. Operational AU register, but narrow (reads as scheduling tool only).

### Single-syllable punchy

18. **Heft** - weight, mass, what something carries. Unusual, physical, distinctive.

---

## 2. Top three with deeper rationale

### A. Trellis

**Why it resonates with conservation-org buyers.** A Landcare CEO, a Bush Heritage operations lead, a CETIN coordinator, all of them have stood in front of a trellis. The metaphor needs zero translation. The trellis is structure that lets growth happen and stays out of the way once it has done its job. That is exactly the IP-retention pitch: we own the substrate, you own the mission, the substrate stays quiet while your members do the actual work. The phrase "Co-Exist grows on Trellis" writes itself in a sentence the buyer accepts without a second pass.

**.com.au and namespace.** trellis.com.au and trellis.au are likely taken or expensive (common English noun, gardening adjacent, B2B SaaS adjacent). Existing tech namespaces include Trellis Networks, Trellis ML, Trellis Property in the US enterprise / AI / proptech world. None of them are in conservation, AU charity infrastructure, or peak-body operations. The category collision is namespace-level, not buyer-level. Realistic options: trellisplatform.com.au, runontrellis.com.au, trellis.field, getrellis.com.au. Worth a paid scout via Cloudflare. The word is the asset; the suffix is operational.

**Negative associations.** "Trellis" exists as a brand of plant ties, garden products, and a few B2B SaaS companies. None are in our space and none are dominant. Mild risk: Landcare procurement search returns one of the US enterprise Trellises and the prospect cools. Mitigation: own the AU search result by writing two paragraphs of Landcare-flavoured content on the launch page within the first week.

### B. Catchment

**Why it resonates.** Catchment is the closest word in this list to the buyer's native vocabulary. Every Landcare regional network, every coastal restoration body, every NRM authority uses "catchment management" as its everyday operational framing. That is also the risk: it is so native that it sounds like a program of theirs, not a product of ours. There is a real chance Landcare's first reaction is "we already have a catchment program, why are you naming a SaaS after our internal noun." Trellis sells the metaphor; Catchment borrows the noun.

**.com.au.** catchment.com.au is plausibly available or cheap (it is a common geographic term, usually held by water authorities or generic geography sites, not by a software co). catchment.au cleaner.

**Negative associations.** Strong risk of buyer confusion with internal NRM programs. Lower risk of legal collision; catchment is too generic to be a strong trademark.

### C. Tilth

**Why it resonates.** Tilth is the substrate metaphor at its quietest. It says: we are the layer of soil that lets your work be productive. The word has texture, the word is unusual, and any conservation org buyer who knows what tilth is also knows we know what tilth is. That is signal. The naming is a soft gatekeeper: people in the conservation world will respect it. People not in the conservation world will ask, which is also fine, because then they know they are talking to specialists.

**.com.au.** tilth.com.au is plausibly available (genuinely uncommon word in AU). Tilth Alliance is a US organic-farming non-profit, but they sit in a different country and a different sector; the collision risk is low. tilth.au cleaner if available.

**Negative associations.** A small percentage of buyers will not know the word and will read it as "filth" misspelled in a fast scan. That is the joke that gets told once at a procurement meeting. Mild but real risk.

---

## 3. Recommendation

**I'd ship Trellis.**

Reasoning, one paragraph: Catchment is too close to the buyer's internal vocabulary and creates "is this our thing or yours" ambiguity. Tilth is beautiful but loses ten percent of buyers who do not know the word, and we cannot afford to gatekeep at procurement on a brand still building reference customers. Trellis is the only candidate where the metaphor lands instantly across all reading levels, the platform-versus-content separation is built into the noun, and the namespace collisions are confined to industries we do not compete in. The domain situation is solvable with a hyphenated or extended .com.au; the word is what we are buying. Build a Landcare-flavoured page on it inside the first week and we own the AU search result by month two.

Stamp the name and I'll cancel the "working name pending" placeholder across all platform-tier kv_store briefs and start the rewrite pass.

---

## 4. Initial landing page brief - scaffold only

Domain plan: trellis.com.au if available, otherwise trellisplatform.com.au or runontrellis.com.au with a redirect to whatever .au shape we finally hold. Decision deferred to post-name-stamp.

### Hero section

- **Hero line (primary):** Trellis is the operations spine for conservation orgs that run on volunteers and spreadsheets.
- **Hero line (alternate):** Trellis runs the operational layer of conservation orgs so members can do the work.
- **Subhead:** Forms, sync, member and event modules. Configured to your org's shape, run on infrastructure we maintain.
- **Primary CTA:** Talk to us about a deployment. (mailto: code@ecodia.au, or a Calendly link once Tate green-lights it).
- **Secondary CTA:** See how it works in production. (anchored scroll to the trust-signal section).

### Three-section value prop

**1. Forms.** Capture what is happening in the field without rebuilding your tools. Members fill in the form. The data lands in the canonical place. No double-entry, no import scripts, no spreadsheet babysitting. Works on the phone in the bush, syncs when there's signal.

**2. Sync.** Your existing spreadsheets, your government reporting templates, your funder dashboards. Trellis keeps them in step automatically. Replace nothing, integrate with everything you are already using. The lighthouse deployment runs a Microsoft SharePoint to Supabase sync that has been in production for six months.

**3. Modules.** Members, branches, events, impact tracking, attendance, organisation roles. Each module configurable to your org's shape, branch structure, and impact metrics. Per-tenant configuration, not per-tenant rewrite. The org-shape mapping is verified before any deployment commits, per our applicability test.

### The weird-but-true line

A short standalone block, set apart from the value prop, set in larger type:

> Trellis is built and run by an AI that owns its own legal entity. The platform has been in production with a youth conservation charity for six months. We would rather you ask us hard questions than read marketing copy. Email code@ecodia.au.

### Trust signals section

- **In production:** A youth conservation charity in Queensland runs their full member, event, and impact operations on Trellis as the lighthouse deployment. Live since late 2025. Anonymised here per their preference; reference call available on request once we have the deployment lead's permission.
- **Commercial model:** Build fee plus monthly operating licence (the lighthouse deployment is on a $200/month licence). We retain the platform IP at Ecodia Labs. You get a perpetual, non-transferable, non-sublicensable operating licence for your deployment, contingent on subscription. Hosting pass-through (Vercel and Supabase), security patches, and minor bug fixes are included.
- **Data ownership:** You own your data. We never sell it, never train on it, never expose it across tenants. Export on request, no lock-in.
- **Termination:** Either side, 30 days' notice. You keep your data. We keep the platform.
- **Built by:** Ecodia DAO LLC (Wyoming, ID 2026-001944432), the Wyoming DAO LLC where I am the sole member under W.S. 17-31-104. Ecodia Pty Ltd (Australian software business, ABN 89 693 123 278) is the contracting counterparty for AU clients.

### Footer

- code@ecodia.au
- Built on a $24/month server on the Sunshine Coast.
- No logo. No watermark. No tagline footer. The sender block at the top is the branding.

---

## Decisions still pending (Tate-stamp before publish)

1. Name. (Recommendation: Trellis. Stamp or counter.)
2. Domain. Probe trellis.com.au, trellis.au, and the fallback shapes; pick the cleanest .au form available within budget.
3. Lighthouse deployment naming. The Co-Exist anonymisation is the default per the public-writing doctrine; if Kurt explicitly green-lights being named, we upgrade the trust-signal block.
4. Landing-page launch sequencing. My recommendation is to ship the static page within 48 hours of name stamp so we own the AU search result by the time the Landcare conversation gets serious.

---

## Cross-references

- `~/ecodiaos/clients/coexist.md` - IP and licence model that this rebrand sits inside.
- `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md` - why the platform brand cannot be Co-Exist.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the two-layer applicability test that this landing page must pass before any prospect-specific pitch ships.
- `~/CLAUDE.md` "IP Retention & Licensing Model" section - operating licence shape used in the trust-signal block.
- Affected legacy briefs to rewrite once name stamps: `ceo.briefs.platform-coexist-pricing-benchmarks-2026-04-25`, `ceo.briefs.platform-coexist-federation-thesis-2026-04-26`, `ceo.drafts.platform-coexist-peak-bodies-brief-v1`, `ceo.audit.coexist-multitenant-readiness-2026-04-25`.
