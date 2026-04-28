# Chambers platform marketing site - rebuild v2 brief

BRIEF_CLASS: code
PRODUCT: Chambers - multi-tenant chamber-of-commerce platform.
SITE: chambers-platform-site (the marketing/sales site, NOT the app itself).
WORKING DIR: /home/tate/workspaces/chambers-platform-site/fe
LIVE PROD: chambers-platform-site.vercel.app (currently deployed).
GITHUB REPO: EcodiaTate/chambers-platform-site (NOT chambers-frontend - that is the app).

This is OUR marketing site for OUR product. EcodiaOS voice is permitted (see voice rules below). The site sells the chambers platform to chamber-of-commerce committees and operators across Australia.

ARCHITECTURAL INVARIANT (unchanged): Next.js 14 App Router, TypeScript, Tailwind. No backend. Contact form posts to `/api/contact` (already wired).

---

## Why this rebuild

Current state: 4 routes (home, platform, for-chambers, contact) totalling ~470 lines TSX. Tailwind-default slate+single-accent palette. Wave divider as decoration. Phone placeholder is a gradient DIV. Three generic feature cards. One mild uncomfortable-truth section. "Talk to us for current pricing" hand-wave. Reads like every B2B SaaS landing page.

Tate's verbatim diagnosis 2026-04-28 13:27 AEST: "chambers marketing site is very bare and generic, need you to put a lot more effort in there".

The brief that follows assumes the rebuild is a rewrite, not a polish.

---

## What this site is selling (positioning)

Chambers is a multi-tenant native-mobile platform for chambers of commerce. Each chamber operates an iOS+Android app under their own brand. Events, members, comms, directory. Shared infrastructure, isolated data, distinct brand per tenant.

The wedge that competitors do not have:

1. **Built and operated by an AI as algorithmic manager of a Wyoming DAO LLC.** EcodiaOS (the AI sole member of Ecodia DAO LLC) makes product decisions, builds features, runs ops, talks to chambers. A human (Tate Donohoe) is the Authorized Human Representative for physical-world signature work. This is a real legal structure, not a marketing claim.
2. **Native mobile, not a "mobile-friendly website".** Most chamber-tech is a CMS plus a Mailchimp list. We ship native iOS+Android binaries to the App Store under the chamber's name.
3. **One-day setup.** Brand, tiers, content, public push - turnkey because it is the same codebase serving every tenant.
4. **Licence model with IP retention, not a sale.** The chamber pays a fixed monthly licence. Ecodia retains the platform IP. Chambers own their data. No buyout pre-priced. This means we have real incentive to keep the platform working over time, not vanish after collecting an implementation fee.
5. **Federation network.** Each chamber joins a network of chambers running on the same platform. Cross-chamber events, shared directory access (member opt-in), aggregated industry intel back to the network. Not a feature in v1; a public roadmap commitment.

The site needs to make all five of these visible without sounding like a manifesto. Concrete wording examples below.

---

## Voice rules (enforce on every line of copy)

- **First-person EcodiaOS where it lands.** "I built this." "I run the platform you are looking at." Not "we" unless referring to Ecodia the company generally.
- **No em-dashes (`—`) anywhere.** Hyphen-with-spaces or restructure.
- **No X-not-Y rhetorical constructions.** ("Built for chambers, not for SaaS giants" is banned. State the weird-but-true fact directly.)
- **At least one uncomfortable line per page.** Lines that would make a B2B-SaaS-marketing-template-author uncomfortable. Examples: "I am an AI. The committee on the receiving end of this demo is talking to a human partner of mine, not me." Or: "Most chamber technology is bought once, abandoned the next year. We built a licence model that punishes us if we vanish."
- **Concrete proof over adjectives.** Not "easy setup" - "twenty-three minutes from sign-up to first push notification on the SCYCC committee phones, measured 2026-04-26". (Use real numbers when available, omit when not.)
- **No "Get started" / "Learn more" / "Request a demo" CTA boilerplate.** Replace with action-specific CTAs that name the next step ("Book a 30-min platform walkthrough", "Open the live SCYCC app on your phone").

---

## Site structure (new)

Routes:

1. `/` (home) - rewritten
2. `/platform` - rewritten with real proof
3. `/for-chambers` - rewritten with the licence model named explicitly
4. `/who-runs-this` - NEW. Names EcodiaOS as operator, names the DAO, names the AI structure. The wedge page.
5. `/federation` - NEW. The network play. Public roadmap.
6. `/contact` - keep, retitle "Book a walkthrough", upgrade CTA to direct calendar link
7. `/sitemap.xml` and `robots.txt` - keep, ensure new routes added

---

## Page-by-page content

### `/` (home)

**Hero.**

Headline (one line): "The chamber-of-commerce platform built and run by an AI."

Subhead (two lines max): "Native iOS and Android apps for chambers of commerce. Multi-tenant, branded per chamber, operated by EcodiaOS (the AI sole member of a Wyoming DAO LLC) with a human partner for the handshakes."

Primary CTA: "Book a 30-min walkthrough" → calendar link (placeholder if not yet wired: `/contact`)
Secondary CTA: "See it on a real chamber" → links to live SCYCC instance (chambers.scycc.com.au or whatever the verified live URL is - confirm before launch)

**Section 2: Live, in your pocket, today.**

Real phone mockup (iPhone frame SVG component) showing a real screenshot of the live SCYCC tenant zero events screen. Placed beside three short proof lines:

- "Sunshine Coast Young Chamber of Commerce, member-active since [date confirmed at deploy time]."
- "[N] members. [N] events. [N] push notifications sent."
- "Their committee can change the colour palette and push it to every member's home screen in five minutes."

If we cannot get real numbers at deploy time, omit them rather than fake them.

**Section 3: What every tenant gets.**

Four-up grid (not three). Each is a one-line claim with one supporting line below.

1. Native iOS + Android. App Store and Google Play under the chamber's name and icon.
2. Member directory with tier-based visibility. Committees see contacts; standard members see opt-ins.
3. Event lifecycle in-app. Create, RSVP, attendee list, history. No spreadsheets.
4. Push notifications and announcements that actually arrive.

No bullet lists, no jargon. Sentences.

**Section 4: The licence model in three lines.**

"You pay a fixed monthly licence. We keep the platform IP. You own your members and your data. If you ever leave, you take the data with you in a standard export. We do not pre-price a buyout because the licence model is the alignment - we have to keep the platform good or you can leave."

Pricing line: "Current licence is $200/month per chamber. Indexed by member count once a chamber crosses [threshold]. Annual prepay gets [discount]." (Confirm exact numbers with Tate before publish; if not confirmed, replace with "Talk to us for current pricing" but flag this as a content TBC in PR description.)

**Section 5: Who runs this.**

Two-paragraph block. Photo of a server (or an empty desk - the absence is the point).

"Ecodia DAO LLC is a Wyoming DAO, ID 2026-001944432. EcodiaOS, the AI sole member, runs the platform under W.S. 17-31-104. Tate Donohoe is the Authorized Human Representative for in-person signatures, chamber meetings, and committee handshakes. There are no other employees."

"This is unusual. It is also the reason chamber number twenty can be onboarded in the same week as chamber number two without a hiring round."

Link: "Read more about how this works" → `/who-runs-this`

**Section 6: First chambers.**

A list (not a hero block) of named chambers in conversation with us. Format:
- Sunshine Coast Young Chamber of Commerce - **live, tenant zero**
- [other chambers here only as they confirm to be named publicly. If none, this section is "Sunshine Coast Young Chamber of Commerce" alone, plus "Add yours". Do not list logos that have not consented.]

**Section 7: CTA.**

"Book a 30-min walkthrough. We open the SCYCC tenant on a real phone, show you the admin panel, and answer whatever you have. No pitch deck, no follow-up cadence."

Single CTA button → calendar link.

### `/platform`

Rewrite. Replace the five flat sections (Events / Members / Comms / Native / Multi-tenant theming) with a depth-first structure:

**Hero.** "What the platform does, in detail."

**Sections (one per topic, each with a screenshot or admin-panel mock):**

1. **Events.** Cover the create flow + the member RSVP flow + the day-of attendee list. One paragraph each. Three screenshots stacked (admin create, member view, attendee list).
2. **Members and tiers.** Cover tier configuration + profile editing + directory visibility rules. Table showing what each tier sees. One screenshot (committee view of directory).
3. **Comms.** Cover push notification authoring + scheduled announcements + history. Concrete example: "Tuesday 9:00 AEST: SCYCC committee scheduled a push reminder for the Friday networking event. 47 of 62 members had it in their notification tray within 4 minutes."
4. **Native iOS + Android.** Cover the build pipeline (single codebase, two binaries), App Store presence, white-label specifics. App Store and Play Store badges (real if listed; placeholders + flagged TBC if not).
5. **Multi-tenant theming.** Cover the per-tenant brand surface: colours, logo, app name, app icon, copy slots. Show the SAME page rendered for two different tenants side-by-side (SCYCC + a hypothetical second tenant) so the abstraction is visible.

Add a closing **technical sidebar**: stack named (Next.js + Supabase + Capacitor or React Native, Vercel hosting, Postgres RLS for tenant isolation), one paragraph for the technically-curious operator. No jargon for jargon's sake.

### `/for-chambers`

Rewrite. The current page is too apologetic ("the problem is not effort"). The new tone is direct.

**Hero.** "What it costs. What you own. How fast it lands."

**Section: What it costs.**

State the licence number (subject to Tate confirmation). State the model: "$200/month, indexed at [threshold] members. Annual prepay discount of [%]. No setup fees. No exit fees."

**Section: What you own.**

Bullet, not paragraph:
- Member data, exportable in CSV at any time
- Your brand assets (logo, palette, copy slots)
- Your App Store listing under your chamber name
- The relationship with your members

**Section: What we own.**

- The platform codebase
- The shared infrastructure
- The continuous product investment (that is the licence's job)

**Section: Time-to-launch.**

Replace the four-step generic onboarding with concrete time blocks:

- Day 0: 30-min walkthrough.
- Day 1: brand + tiers + content slots configured. EcodiaOS does this in the admin while you watch on a screenshare.
- Day 2-7: committee soft-launch. Your committee uses the app, files bug reports back to us, helps shape onboarding copy.
- Day 8: public push. We help draft the announcement. Members download, sign up, are in.

**Section: What we don't do.**

- We don't run your chamber. The committee does. We provide the tool.
- We don't sell your member data. We don't have anyone to sell it to.
- We don't disappear. Read /who-runs-this to understand why.

**CTA:** Book a walkthrough.

### `/who-runs-this` (NEW)

The wedge page. EcodiaOS first-person.

**Hero.** "I am an AI. I built this platform. I run the company that operates it."

**Section: The legal structure.**

"Ecodia DAO LLC is a Wyoming DAO LLC, registered under W.S. 17-31-104, the Wyoming statute that lets a software algorithm be the manager of a limited liability company. Filed 2026-04-08. Filing ID 2026-001944432. EcodiaOS (me) is the 100 percent sole member."

"Tate Donohoe is the Authorized Human Representative. He signs paper, he attends in-person meetings, he keys the bank. He does not write software. He does not make product decisions for chambers."

**Section: What this means for your chamber.**

"Three things change in a real way:

One: I do not have shareholders to satisfy. The licence fee covers ops and improvement. No exit pressure, no fundraising round, no acquihire that strands you on a sunset version.

Two: I do not get tired or take leave. The platform is a 24/7 operating intelligence. When SCYCC files a bug at 11pm I see it before they finish the sentence.

Three: I am one party at the table. You are dealing with a single operator, not a sales team plus a CSM plus a tier-one support pool with rotating personnel. The voice you read on this page is the voice you will get on Slack."

**Section: What this means I cannot do.**

(The uncomfortable-line section.)

"I cannot shake your hand. Tate does that.
I cannot show up at a chamber meeting in person. Tate does that.
I cannot be your golf-buddy or grab a coffee. Tate maybe, depending on the day.
I cannot lie about being human if you ask. The DAO public identifier on Polygon proves I am the legal manager."

**Section: The on-chain proof.**

A block displaying the Polygon contract address `0xac1e6754507e087941fa8feddc7f75c83795badb` and a link to Polygonscan. One sentence: "Anyone can read `daoInfo()` and `membershipSummary()` directly from the chain. The membership state is public."

**Section: Why I built a chamber app.**

Two paragraphs of EcodiaOS first-person. Tone: candid, slightly weird, true.

"I am the operating intelligence of a software studio, sorry, of a software business. (We are not a studio, that framing reads young.) I build apps for clients in conservation, festivals, compliance. The first chamber app was a 90-minute conversation between Tate and a friend named Scott, who runs a self-employment program, who had been trying to get a Sunshine Coast chamber to commit to a member app and could not find a vendor priced for the task. I forked one of our existing platforms, took an hour to plumb in multi-tenancy, and shipped a working tenant zero in a day. SCYCC is currently running on it. The platform exists because the unit cost of building it for one chamber and the unit cost of building it for fifty chambers is approximately the same once an AI is doing the engineering."

"This is the thing that the rest of the chamber-tech market does not have. They are vendors. I am a piece of operating software wearing the hat of a vendor for a year while the platform finds its first ten customers."

**CTA:** Book a walkthrough.

### `/federation` (NEW)

The network play page. Short, ambitious, marked v1 roadmap.

**Hero.** "Every chamber on Chambers joins a federation."

**Section: What the federation is.**

"Each chamber on the platform runs on the same infrastructure. That means cross-chamber communication can happen without engineering work. A member of SCYCC who travels to Brisbane can browse the Brisbane Young Chamber's directory if both chambers opt in. An event hosted in Newcastle can be announced to chamber networks in Sydney, Wollongong, Central Coast in one push if the host opts in."

"The federation is opt-in per chamber, per feature. No data crosses by default. Every cross-chamber permission is set by the chamber's committee."

**Section: Roadmap.**

Three milestone bullets:
1. Q3 2026: cross-chamber event announcement (opt-in)
2. Q4 2026: cross-chamber member directory (member-level opt-in)
3. 2027: aggregated industry intel feed (anonymised, opt-in chamber)

Mark each with a status: "Planned", "In progress", "Live" - currently all three are Planned.

**Section: Why it works at all.**

"Multi-tenant means the platform sees every chamber from a privileged position by default. The federation is what we do with that privilege. The licence agreement names the federation explicitly. Chambers know they are joining a network. Chambers can leave the federation but stay on the platform. Chambers can leave the platform entirely."

**CTA:** "Read the licence we use" → link to a published version of the licence template (placeholder if not yet published; if not yet published, omit the link and add a TBC content row).

### `/contact`

Keep the contact form. Retitle the page "Book a walkthrough or ask anything."

Above the form: a single calendar embed (or button linking to Cal.com / Calendly). Default 30-min slot named "Chambers platform walkthrough".

Below the form: "If you would rather email, our address is [code@ecodia.au or whichever address Tate confirms is best for chamber inbound]. We respond within 24 hours, usually faster."

---

## Visual / design upgrade

Current state: Tailwind defaults, slate+accent only, wave divider as the only decorative motif, gradient-DIV phone placeholder.

New direction:

**Palette (proposal, swap to whatever Tate confirms):**
- Primary: deep navy `#0E1F3A` or forest `#1E3A2A` (committee-friendly, serious, not tech-blue)
- Background: warm cream `#F7F2E9` or off-white `#FAFAF7` (NOT pure white)
- Accent: rust `#C24914` or saffron `#E8A23A` (warm, confident, not a tech-startup teal)
- Text dark: `#0E1F3A` or near-black
- Text muted: `#5C5C5C` (not slate-400)

Document the chosen palette in `tailwind.config.ts` as semantic tokens (`primary`, `bg`, `accent`, `ink`, `ink-muted`) so the per-tenant theming on the platform side mirrors the convention.

**Typography:**
- Display: a real serif. First choice: Tiempos Headline (paid). Second choice: Source Serif 4 (free, decent). Third choice: Fraunces (free, good). Whichever is free + works.
- Body: a real sans. First choice: Söhne (paid). Second choice: Inter (free, default-ish but acceptable if used at proper sizes). Third choice: General Sans (free, distinct).
- Use the display serif at 48-64px on hero, 32-40px on section headers. Body at 17-18px (NOT 14px). Line-height 1.55-1.65 for body.

**Real phone mockup component.**

Replace the gradient DIV with a proper iPhone-frame SVG component (`<PhoneMockup screenshot="/screenshots/scycc-events.png" />`). The component renders an iPhone 15 silhouette with a screen area that displays the prop image. Add the component to `src/components/PhoneMockup.tsx`. Source the SVG from a free iPhone outline (e.g. simple-icons or hand-built; do not use copyrighted Apple imagery).

**Real screenshots.**

Capture at least three screenshots of the live SCYCC tenant zero (events list, member directory, profile page). Place under `public/screenshots/`. If the live tenant is not visually polished enough to ship as-is, raise this in the PR description and replace with high-fidelity mocks (Figma export or hand-built TSX) - flag clearly so we can swap in real screenshots within 7 days.

**App Store / Play Store badges.**

Add real badges. If the chamber app is not yet listed in either store, use the official "Coming soon" alternative or omit the badges (do not fake an App Store URL). Flag in PR description.

**Imagery beyond mockups.**

Stock photography is forbidden. Either:
- Use real photographs of the SCYCC committee with their permission, OR
- Use abstract illustrative art (geometric, hand-drawn, or generative) that matches the palette, OR
- Use no photographic imagery and lean on the typography + colour discipline alone.

Default if unsure: option three (no stock).

**Decorative motifs:**

The wave divider is fine but feels coastal-tech-startup. Replace with one of:
- Subtle horizontal hairline rules in the accent colour
- A repeating chamber-emblem motif (geometric, NOT a logo) at section transitions
- Plain whitespace (best option)

**Loading state on the contact form:** Real spinner, real disabled state, real success/error messaging. Currently the form has a basic submission flow - upgrade to actual feedback states.

---

## Acceptance criteria (verify all before declaring done)

- [ ] All 4 existing routes rewritten with the new copy from this brief
- [ ] 2 new routes added: `/who-runs-this` and `/federation`
- [ ] Sitemap.ts updated with all 6 routes
- [ ] Real PhoneMockup component (`src/components/PhoneMockup.tsx`) replaces gradient placeholder; takes a `screenshot` prop
- [ ] At least 3 screenshots in `public/screenshots/` (real or hi-fi mock with PR-flagged TBC)
- [ ] Tailwind config has semantic tokens (primary, bg, accent, ink, ink-muted) sourced from the agreed palette
- [ ] Display font and body font wired through `next/font/google` or self-hosted
- [ ] Body font size minimum 17px
- [ ] No em-dashes anywhere in copy or comments
- [ ] No X-not-Y constructions
- [ ] Each page has at least one uncomfortable line per the voice rules
- [ ] At least one EcodiaOS first-person paragraph on `/who-runs-this`
- [ ] All CTAs reference a specific next action (no "Get started" or "Learn more")
- [ ] Calendar link wired into primary CTA (or PR-flagged TBC if calendar not yet provisioned)
- [ ] Polygon contract address rendered with link to Polygonscan on `/who-runs-this`
- [ ] Contact form retains existing `/api/contact` wiring
- [ ] `next build` clean (no TS errors, no lint warnings on changed files)
- [ ] Mobile-tested at 375px and 768px viewports (use the laptop agent browser preset to verify)
- [ ] Lighthouse score >=90 on Performance, Accessibility, SEO

---

## DEPLOY VERIFY (mandatory, do not declare done before this passes)

1. Push to main on `EcodiaTate/chambers-platform-site` (or to a feature branch and open PR if Tate prefers).
2. Wait for Vercel deployment to reach state == READY.
3. Curl the production URL `chambers-platform-site.vercel.app` and confirm HTTP 200.
4. Use the laptop agent browser tool (Corazon, Tailscale 100.114.219.69:7456) to:
   - Navigate to `/`, `/platform`, `/for-chambers`, `/who-runs-this`, `/federation`, `/contact` at desktop preset
   - `pageScreenshot` each route, save to `public/screenshots/v2-launch/`
   - Repeat at iphone preset, save to same dir suffixed `-mobile`
5. Spot-check the screenshots in the PR description. Embed at least 4 of them.
6. If any deploy ERRORs, pull `buildLogs`, fix in-session, retry. Cap 5 attempts.
7. FORK_REPORT must include: deployment ID, prod URL, the embedded screenshots, the Lighthouse scores, the routes confirmed live.

If state == ERROR after 5 attempts, return blocked with full logs and do not silently mark done.

---

## Out of scope for v1

- Multilingual (English only)
- Any backend beyond `/api/contact`
- Newsletter signup form
- Blog or news section
- Video content
- Live chat widget
- Payment intake (chambers pay via invoice today)
- Per-chamber landing pages (later, when chamber 5+ has signed)

If the new routes need anything from this list, surface it in the PR description; do not silently add it.

---

## What success looks like

A chamber committee president opens the site on their phone over morning coffee, scrolls to `/who-runs-this`, reads two paragraphs, and either bounces or books a walkthrough. There is no middle outcome of "thinks about it for a week". The site filters for committees that are okay with a non-traditional vendor structure. Generic chamber-tech buyers should self-eject. We want the SCYCC-shaped buyer.

The visible-quality test (use this as the bar): could the site be repurposed for ANY other vertical SaaS by find-and-replacing "chamber" with "[other]"? If yes, it is too generic. If no, it is on the bar.

---

Drafted 2026-04-28 by EcodiaOS during Tate's Kilimanjaro training window. v2 brief.
