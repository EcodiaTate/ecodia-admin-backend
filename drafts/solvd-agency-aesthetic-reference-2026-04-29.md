# Solvd reconnaissance - 2026-04-29 (fork_mojanto7_928e32)

**URL resolution attempts:**
- `solvd.agency` - DNS resolution failed (NXDOMAIN).
- `solvd.co` - connection reset.
- `solvd.com` - resolved. "An AI-first advisory and digital engineering firm | Solvd". Large B2B brand.

**Conclusion on URL fit:** solvd.com is the only resolvable variant but its aesthetic does NOT match Tate's "fucking sick" + "abruptly disruptively opposite of what you'd expect from a software company" framing. solvd.com reads as conventional polished B2B SaaS (large gradient hero, bento-grid stats, client-logo bar, three-column feature sections, conventional CTA buttons). Tate met a contact at a Sunshine Coast Young Chamber event - the actual company is almost certainly a small AU agency, not the global "AI-first advisory" Solvd. I cannot find the correct URL inside the 2-minute budget the brief allows.

**Fallback per brief instruction:** proceed with brutalist + single-screen + functional-data hybrid as the default aesthetic. Documented here AND will be documented in the PR body so Tate can correct the URL on review.

## Visual patterns observed on solvd.com (for what they're worth)

1. **Dark hero with massive sans-serif headline ("Where AI meets ROI"); strong contrast between hero block and following sections via abrupt full-width color blocks (dark → green → light → green → light).** Useful: the abrupt-color-block transition is more interesting than smooth-gradient bleed.
2. **Stat slabs as primary content (10+, 27, 36, 115).** Numerical, no narrative copy. Useful: numbers ARE content. Aligns with "functional only" candidate from the addendum.
3. **Small all-caps mono eyebrow labels above each section title.** Useful: monospace as structural element, not just hero.
4. **Client-logo bar high in the page (UveX, Salesforce-style brands).** Borrowed-credibility pattern. NOT useful for Ecodia v2 - we have no enterprise logos and that's the wedge.
5. **CTAs are conventional "Manage Cookies / Get Started" rectangle buttons.** Generic. Reject this for v2.

## Aesthetic direction chosen for ecodia-site v2

**Hybrid: single-screen statement + functional-data + brutalist-monospace.**

- One viewport. No scroll narrative on home.
- Wedge facts as primary content, not as marketing copy. Filing ID, statute citation, contract address rendered in monospace as structural elements.
- Small all-caps mono eyebrow labels (the one solvd.com pattern worth borrowing).
- No gradient hero. No client-logo bar. No three-feature grid. No testimonials. No "Get started" CTA.
- CTAs name specific actions (`Email the operator` mailto, `Read the Operating Agreement` PDF, `See the contract on Polygonscan` external link).
- Monospace base font with serif/sans for body copy where readability requires it.

This is what Ecodia would build if it stopped trying to look like every other software company.
