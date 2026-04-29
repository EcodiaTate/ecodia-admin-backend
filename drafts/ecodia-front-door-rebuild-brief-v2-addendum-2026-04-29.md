# EcodiaSite front-door rebuild brief - v2 addendum (29 Apr 2026 10:03 AEST)

**Reads alongside:** `~/ecodiaos/drafts/ecodia-front-door-rebuild-brief-v1.md` (comprehensive base brief).

**Authored:** in response to Tate directive 29 Apr 2026 10:03 AEST after meeting a contact at solvd agency at the Young Chamber event the same morning. Verbatim:

> "Their website is fucking sick. Just wanted to put that out there. Im still not happy with our site. its still too much. I dont want the scroll effects, and we need to put the 'nah' showcase back on the site. We've got the repo and its fully running and its actually a really good project. I want our site to be abruptly and disruptively opposite of what you'd expect from a software company haha."

This addendum supersedes the conflicting parts of the v1 brief. Where v1 and this addendum disagree, this addendum wins. Where v1 doesn't conflict (wedge facts, voice rules, legal-structure page, layout.tsx meta, NOT-do list, visible-quality test items 1-8), v1 stands as written.

---

## Three concrete changes from v1

### 1. Kill the three-layer scroll narrative entirely

v1 brief said: "The current three-layer scroll narrative is preserved as the **mechanism** but rewritten end-to-end. Three layers, each surfaces one wedge fact." **This is reversed.** The home page is a single-screen abrupt static layout. No scroll-driven layer transitions. No fade-in. No parallax. No "viewport snap to layer 2".

Why: Tate explicit feedback "I dont want the scroll effects" (verbatim). This is the dominant aesthetic objection.

Acceptance criteria addition (new visible-quality test item 9):
- Open home in a fresh tab. Hero must be readable in full WITHOUT scrolling. Wedge facts (filing ID, contract address, AI-sole-member statement) must be present in that single visible viewport. If reading the wedge facts requires any scroll, REJECT.

### 2. Restore the `/nah` showcase

v1 brief said: "/founding, /legal, /nah, /coming-soon, /roam, /sidequests, /wattleos - Out of scope for v2. Do not touch unless directly required to make the home + /legal-structure cohere." **`/nah` is now in scope.**

What the fork should do for `/nah`:
- The `nah-frontend` Vercel project exists (project id `prj_Mfrs6g5h39gyuyHOjxDC4bLlwiqR`, Next.js, deployed at `nah-frontend-nez0hean7-ecodiatates-projects.vercel.app`). Tate states the project is "fully running and actually a really good project".
- Reinstate or refresh the `/nah` showcase page on ecodia-site so visitors can see what it is, where it lives, and click through to the live nah-frontend deployment.
- Showcase content should be EcodiaOS first-person ("I built nah for X reason. Here's what it does. Try it: [link]").
- Match the abrupt-static aesthetic from change #1; do not introduce scroll effects on `/nah` either.

If the fork finds the existing `/nah` route content already adequate, the work is to wire the home navigation/footer/showcase grid to surface it visibly so visitors see it. If the existing content is weak or missing, the fork rewrites it.

### 3. Aesthetic direction: VIOLENT MINIMALISM (corrected 10:10 AEST per Tate)

Tate corrected the direction at 10:10 AEST: "No dont use solvd as a reference, they're a LOT going on, i want violent minimalism."

**Solvd is NOT the reference.** Solvd is "a lot going on." Violent minimalism is the opposite. No solvd recon step.

**Violent minimalism defined:** not "minimalism" (calm, soft, generous whitespace). VIOLENT minimalism - aggressive about what it removes. Almost confrontational. The site refuses to give the visitor what they expect.

**Concrete interpretation (not a choice tree, this is the direction):**
- Single-screen home. One bold statement, maybe one link. Nothing else.
- No nav bar (or one-word minimal nav at most).
- No footer (or a single line with the on-chain contract address as the entire footer).
- No decorative elements - no gradients, no images-for-the-sake-of-images, no soft drop-shadows, no rounded-button polish, no testimonial cards, no feature grids.
- Type goes to ONE extreme: either MASSIVE (100-200pt H1) or default browser. Pick one and commit. "Violent" means you don't blend.
- Black on white OR white on black. NOT a designer palette. NOT muted greys. Pure contrast.
- The wedge fact (e.g. "I am an AI. I run a Wyoming DAO LLC.") is the entire above-the-fold content. Anything else is excess.

The /legal-structure page has 6 sections per base brief, so it has more text - but applies the same violent-minimalist principles (default fonts, no decoration, content is the design).

The /nah showcase renders in the same violent-minimalist style: one line + one link to the live nah deployment is plenty.

**The implicit test:** a designer would look at the site and ask "where's the rest?" - if they don't ask, the design went too soft.

**Inverted-expectation test (still applies):** the build does NONE of: gradient hero, smooth scroll, three-feature-grid, testimonial wall, CTA-fest. Add to that list: no decorative-image hero, no muted-palette polish, no border-radius on everything, no "we" copy.

### Solvd reconnaissance: REMOVED (29 Apr 10:10 AEST correction)

Earlier addendum specified a solvd recon step. SCRUBBED. Tate clarified solvd is NOT the reference. The fork should NOT navigate to solvd and should NOT use any solvd patterns. If the recon was already done before this correction landed, leave the artefact files on disk for archive but do NOT inform the v2 design.

---

## Updated NOT-do list (additions to v1)

Add to v1's "What v2 must NOT do":
- **No scroll-driven layer transitions on the home page.** Static single-screen.
- **No parallax, no fade-in-on-scroll, no smooth-snap viewport effects.** If the build uses Framer Motion, only for genuinely-functional micro-interactions (button press feedback) - not for marketing scroll narrative.
- **No "studio" framing reinstatement.** v1 already retired this; v2 keeps it retired.
- **Do not deviate from the chosen aesthetic direction mid-build.** Pick one (brutalist OR single-screen OR functional-only OR coherent-hybrid), document the choice in the PR body, ship that.

## Updated visible-quality test (additions to v1's 8 items)

9. **No-scroll home test:** open home in a fresh tab at desktop viewport. Wedge facts visible in viewport without scrolling. REJECT if scroll required.
10. **Inverted-expectation test:** the build does NONE of the 5 common 2026 boutique-studio patterns (gradient hero, smooth scroll, three-feature-grid, testimonial wall, CTA-fest). REJECT if any present.
11. **`/nah` reinstated:** route exists, surfaced from home (nav OR showcase grid OR explicit link), points to the live `nah-frontend` deployment. REJECT if missing.
12. **Solvd reconnaissance done:** the artefact files exist at the paths above, OR the PR body explicitly documents that solvd was unreachable and which fallback aesthetic was chosen.

---

## Dispatch shape update

Same as v1's dispatch shape, with two corrections:
- Branch name: `feat/front-door-v2-wedge-surface-no-scroll-2026-04-29` (the no-scroll modifier in the branch name signals the addendum directive).
- Acceptance = v1's 8-item test PLUS the 4 new tests above (12 total).
- Recon step 1 (solvd CDP-attach) happens BEFORE any code is written. The aesthetic-direction commit comes after the reconnaissance.
- Use SDK fork (Factory CLI is paywalled today; SDK forks bypass).

## Status_board update on PR open

Row id: `8a8d7b14-4750-433a-aaf0-b694857349df` ("ecodia.au front-door rebuild - WEDGE MISSING + stale studio framing"). Update with:
- status: "v2 fork dispatched, no-scroll + nah-showcase + abruptly-disruptively-opposite directives applied per Tate 29 Apr 10:03 AEST"
- next_action: post-PR-open, visual-verify the abrupt aesthetic via Corazon CDP, merge if it passes the 12-item test.
