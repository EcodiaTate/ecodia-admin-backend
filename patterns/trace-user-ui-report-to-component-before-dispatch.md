---
triggers: ui-bug, jess, kurt, tate-relayed-bug, user-reported, ui-report, screen-doesn't-show, missing-from-map, blank-page, doesn't-work, broken-display, member-side, admin-side, visible-bug, render-bug, page-name-assumption, /map, /events, route-vs-component
---

# Trace user UI bug reports to the actual component path BEFORE dispatching a fix

## The rule

When a user reports a UI bug ("X doesn't show on the Y page" / "Z is missing from the map" / "the survey link isn't clearing the task"), the **first action is to grep from the user's described screen back to the actual rendered component path in code**. Do NOT dispatch a fork or write a fix until you have confirmed which file:line is the rendering source. Page names users say (e.g. "the map") frequently do NOT correspond to the route name in code (e.g. there may be no `/map` route at all; the actual map could be an inline component on `/events`).

## Why

Tonight (2026-04-28 22:11 AEST), Jess reported: "added new collective north east vic, shows in admin but not on the member side - hasn't updated the count or put it on the map." I assumed "the map" meant a `/map` page route. Dispatched a fork to investigate at that path. ~10 minutes later Tate had to clarify: "we meant the map previews for the event locations and collective locations.... that /map page shouldnt even exist." The actual rendered map was `<CollectiveMap>` from `src/components/collective-map.tsx`, mounted at 75vh in `src/pages/events/index.tsx:445`. The /map route was a 453-line orphan with zero inbound links.

The fork still ended up on the right surface because the bug fix (adding NE VIC coords to `COLLECTIVE_SLUG_COORDS` in `src/lib/geo.ts`) covered both the orphan page AND the inline component (they share the `useCollectiveMapData` hook). But that was luck. A different kind of bug (e.g. layout-only on the inline component) would have wasted the entire fork on the wrong file. And the redirect cost user-visible time: Tate had to interrupt mid-investigation to correct course.

## Do

Before dispatching ANY fix for a user-reported UI bug:

1. **Identify the user's claimed surface in their words.** Quote their exact phrase. Don't paraphrase.
2. **Grep the codebase for the rendered component path.** Multiple angles:
   - Grep for the literal feature mentioned ("map", "count", "list", "card") and find the component file.
   - Grep for the data hook the feature uses (e.g. `useCollectiveMapData`, `useEvents`) — that traces back to every render site.
   - Grep for the route the user says they're on (e.g. `path="/events"` in App.tsx or routes.ts).
3. **List every file:line where the broken thing IS RENDERED.** There may be more than one.
4. **Write the brief to fix at THAT path or those paths**, not at the route-name-the-user-said. Include the actual file paths in the brief.
5. **If the user mentions a page that doesn't exist as a route, OR exists but isn't linked from anywhere, flag the discrepancy in the brief** so the fork doesn't go down a dead-end OR makes a separate-decision call about that page (kept? deleted?).

## Do NOT

- Assume the user's page name maps to a route name. They are describing what they SEE, not what's in your URL bar.
- Dispatch a fork with brief language like "the X page" without naming the file path. The fork has no other context and will pick the wrong file.
- Skip the grep step because "it's obvious which page they mean." It rarely is.
- Treat a route's existence as evidence the route is in use. Routes with zero inbound links are dead code.

## Protocol when applying

1. User-reported bug arrives (Tate-relayed, direct DM, ticket, Slack).
2. Quote the exact user phrase in your scratch space.
3. Run 3 greps:
   - `Grep "<feature>" src/` to find component files.
   - `Grep "<data hook>" src/` to find data sources.
   - `Grep "<route the user said>" src/App*.tsx` to find route registration (or absence).
4. Cross-reference: does the user's described screen actually live at the route they said, OR is it an inline component on a different route?
5. Write the fork brief with the FULL list of file paths the fix may touch. The fork can narrow; it cannot widen what it didn't get.
6. If a route exists but has zero inbound links, raise that as a separate item (might be deletable).

## Origin

Apr 28 2026 22:11-22:40 AEST. Jess feedback batch relayed by Tate. I dispatched fork_moiluinw (Jess collective bug) with brief language "investigate North East VIC missing from map" without grepping the actual rendered component path. Fork wandered into /map page logic for ~10 minutes. Tate caught it at 22:40 with: "Also one fork i think is looking at a /map page for co-Exist, thats NOT what we meant, we meant the map previews for hte event locations and collective locations.... that /map page shouldnt even exist i dont think." I had to grep on main, identify the actual component (`<CollectiveMap>` on /events, line 445), and the orphan /map route, and dispatch a SEPARATE fork (fork_moimbagy) to delete the orphan. The redirect was preventable with a 60-second grep at the start.

## Cross-references

- Pattern: `visual-verify-is-the-merge-gate-not-tate-review.md` (after the fix ships, visual-verify on the actual rendered surface).
- Pattern: `factory-redirect-before-reject.md` (when a running fork is on the wrong surface, redirect via `mcp__forks__send_message` before aborting).
- The PR for /map deletion (fork_moimbagy → coexist PR #7, merged 1b6ac3e on main) is the doctrine-aligned fix for the parallel finding.
