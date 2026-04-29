---
triggers: placeholder, coming soon, stub, lorem, mock, fake data, dummy, todo, fully implemented, no placeholders, ship quality, complete feature, scycc, chambers, matt, tate-ship-quality, every feature
---

# Every shipped feature is fully implemented. No placeholders, no "coming soon."

## TOP-LINE INVARIANT (29 Apr 2026, Tate scope-expansion on Chambers/SCYCC deliverable)

**When we tell a client "the app is ready" or "go look at it," every visible feature must be fully implemented end-to-end. No `Coming Soon` cards. No `TODO: build this` stubs. No empty groupchat that doesn't actually post messages. No admin button that opens a modal saying "feature in progress." Either the feature is real, or the surface is gone from the UI in this version.**

The bar is: a curious user who taps every button must hit functioning behaviour, not a placeholder. Every nav item, every form, every detail page, every action button - real or removed.

If a feature genuinely cannot be shipped in this version, it is REMOVED from the UI for v1, not stubbed with a placeholder. We add it back when we ship it for real. The shipped surface area is the contract.

## Why

A placeholder feature in a client demo is a trust failure. The client clicks the "create event" button, sees "feature coming soon," and now every other claim about the app is downgraded in their head. They don't differentiate "shipped surface" from "unshipped stub" - they just see brokenness. Once that impression lands, walking it back costs more than the feature would have cost to ship properly.

Specific failure mode that triggered this doctrine: Chambers/SCYCC delivery to Matt. Tate told Matt "I built it, here are the features." Matt: "yeah lets see it." If Matt opens the app and sees `Coming soon` on focus groups or admin tools after Tate listed those features, the verbal commitment evaporates.

## Do

- **Before declaring a fork done, walk every nav item and every visible button.** If any opens a placeholder modal, error message, or empty list with no add-action - the fork is not done.
- **If a feature can't ship in this PR, remove its UI affordance from this PR.** Don't ship a button that opens a `Coming Soon` page. Either ship the real thing or hide the surface.
- **Document removed-for-v1 features in the PR body** so future PRs know what's intentionally absent vs what's a regression.
- **Ship-quality test: would a user who taps every button hit functioning behaviour?** If no, the work isn't done.
- **The client demo URL must be the production app, not a demo branch with extra polish.** What we send and what we ship in main are the same surface.

## Do not

- Ship a `Coming Soon` page or empty-state with no real action behind it.
- Ship a button that opens a modal explaining the feature is in progress.
- Ship lorem-ipsum or mock data on a real-data screen.
- Ship a feature behind a feature flag that's defaulted to off "for safety" - that's the same as not shipping it. If the feature is shippable, ship it on. If it's not, remove the surface.
- Hand a client a "demo" URL that has different code than production. They will compare and the gap erodes trust.

## Protocol when applying

For any client-facing build before declaring it done:

1. **Walk the nav.** Click every top-level nav item. Each must lead to a working screen.
2. **Walk every screen's primary actions.** Each button must do its real work - create, edit, delete, save, send.
3. **Walk every detail page.** No "lorem ipsum," no mock-data placeholders.
4. **Check empty states.** An empty list must offer the create-action, not a "feature coming soon" message.
5. **Check error states.** Errors must be recoverable, not "something went wrong, contact support."
6. **For multi-tenant apps:** the multi-tenancy must be visually obvious - branding, naming, content all reflect the active tenant. Not "Tenant Name" or `{{tenant.name}}` literally rendered.
7. **If anything fails the walk:** either ship the real feature in this PR, or remove the surface from this PR. No third option.

## Doctrine sibling

`~/ecodiaos/patterns/visual-verify-is-the-merge-gate-not-tate-review.md` - the visual-verify gate IS this walk. Reflexive for every UI-touching PR.

## Origin event

2026-04-29 09:20 AEST. Tate, after Young Chamber event where Matt verbally committed to the Chambers app, sent the build-out scope: "make sure its a fully built out app, no placeholder stuff or coming soon things as per documentation (or it should be in the docs if it isnt)." The "or it should be in the docs if it isnt" clause is the directive that authored this file - the doctrine was implicit, now it's explicit.

The Chambers/SCYCC deliverable was the surface that demanded the rule: focus groups, admin/committee tools, event creation, animations, responsive design, all production-quality, all real, all shipped before Matt's email goes out. The Capacitor wrap was deferred to Phase 2 explicitly because wrapping a rough app for TestFlight is the same anti-pattern at a different layer.
