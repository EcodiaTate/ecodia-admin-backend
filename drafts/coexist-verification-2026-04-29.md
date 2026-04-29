# Co-Exist verification - 4 home/photo items (Apr 29 2026)

**Fork:** fork_mojwmois_0ac283
**Brief from Tate:** verify 4 specific UI/feature items shipped on the Co-Exist app. Audit-only - no code changes.
**Codebase:** `/home/tate/workspaces/coexist` (flat layout, working copy of `coexist-fe`).
**Reference commit:** `ca04c31` (2026-04-28 22:18 AEST) - `feat(events): cover image focal-point picker (admin reposition + crop placement) (#3)`.

Headline: events focal-point is real and shipped. Collective focal-point is NOT shipped (UI gap, schema is ready). Home page section ordering does NOT match Tate's spec. Mobile width on Next Event Card looks correct.

---

## Item 1 - Collective photo cropping/resizing/focal-choice

**Status: MISSING**

The collectives admin UI has a working cover-image upload but no focal-point picker is mounted, no position columns are written, and no render site applies the focal point. The schema is ready - the wiring is not.

**Evidence:**

1. Admin collective settings tab does NOT mount the picker. `src/pages/admin/collective-detail.tsx:1067-1132` (the SettingsTab "Cover Image" block). Upload + Replace + Remove are all present. There is no `<CoverImageFocalPointPicker>` import and no JSX for it. Lines 1075-1077 render the cover preview as a plain `<img className="w-full h-full object-cover" />` with no `coverImagePositionStyle()` applied.

2. The mutation handler only writes `cover_image_url`. `src/pages/admin/collective-detail.tsx:996-1002`:

```tsx
const result = await upload(file)
setCoverPreview(result.url)
await updateCollective.mutateAsync({
  collectiveId,
  updates: { cover_image_url: result.url },   // <-- no position cols
})
```

3. Schema supports it - the Database types include focal-point columns on `collectives`. `src/types/database.types.ts:1146-1147`:

```ts
collectives: {
  Row: {
    cover_image_position_x: number
    cover_image_position_y: number
    cover_image_url: string | null
    ...
```

Insert/Update accept the columns at `:1163-1164` and `:1180-1181`. Default values are 50/50 per the column type and the `coverImagePositionStyle` fallback in `src/lib/cover-image.ts:19-21`.

4. No render site applies focal point on collective covers. Searched all collective-related files:
   - `src/pages/admin/collective-detail.tsx:1361-1376` (admin hero) - bare `<img src={detail.cover_image_url}>` with no `coverImagePositionStyle`.
   - `src/pages/admin/collectives.tsx:286-288` (admin grid card) - bare `<img src={c.cover_image_url}>`.
   - `src/pages/public/collective.tsx:251-253` (public collective page hero) - bare `<img src={collective.cover_image_url}>`.
   - `src/pages/collectives/collective-detail.tsx:242-244` (member collective detail hero) - bare `<img src={collective.cover_image_url}>`.

   None of them import `coverImagePositionStyle` or destructure `cover_image_position_x` / `cover_image_position_y`.

5. The reusable picker component IS already extracted and parameterised - it does not need to be event-scoped. `src/components/cover-image-focal-point-picker.tsx:36-45` accepts only `imageUrl`, `x`, `y`, `onChange`, plus optional disabled/preview-aspect. It is wired up for events at `src/pages/events/components/event-form-fields.tsx:235-242`.

**Fix proposal (1 paragraph, audit-only - do not implement in this fork):**

In `src/pages/admin/collective-detail.tsx` SettingsTab (around line 1067), mirror the events pattern: (a) add local `positionX` / `positionY` state initialised from `detail.cover_image_position_x` / `detail.cover_image_position_y` (default 50), reset to 50/50 when a fresh image is uploaded; (b) replace the bare preview `<img>` at line 1077 with one that applies `coverImagePositionStyle(positionX, positionY)` on `style`; (c) mount `<CoverImageFocalPointPicker imageUrl={coverPreview} x={positionX} y={positionY} onChange={onPositionChange} disabled={uploading} />` directly under the upload button block; (d) include `cover_image_position_x` / `cover_image_position_y` in the `updateCollective.mutateAsync({ ..., updates: { cover_image_url, cover_image_position_x, cover_image_position_y } })` call on both the upload-success path AND the focal-point change handler. Then update the four render sites (admin hero, admin grid, public page, member detail) to apply `coverImagePositionStyle(c.cover_image_position_x, c.cover_image_position_y)` on the `<img>` style. Also update the relevant queries (e.g. `useAdminCollectiveDetail`, the public-collective fetch, `useMyCollectives`) to `select('*, cover_image_position_x, cover_image_position_y')` so the values reach the components - several queries currently select `*` so they may already pull them, but verify each one. The component, the schema, and the helper are all already there - this is a wiring gap, not a build.

---

## Item 2 - Event photo cropping/resizing/focal-choice

**Status: SHIPPED**

The events focal-point picker is the reference implementation and it is wired end to end - upload, focal-point selection, persistence to DB, and render at every consumer site that the brief mentions.

**Evidence:**

1. The picker component exists and is reusable: `src/components/cover-image-focal-point-picker.tsx:36-243`. Click-to-set, keyboard arrow nudge, numeric inputs, debounced onChange (default 200ms), live preview with `object-fit: cover` + computed `objectPosition`. v1 is focal-point only (no real cropping) per the docstring at `:33-35`.

2. The picker is mounted in events admin form fields: `src/pages/events/components/event-form-fields.tsx:235-242`:

```tsx
{onPositionChange && (
  <CoverImageFocalPointPicker
    imageUrl={coverImageUrl}
    x={positionX}
    y={positionY}
    onChange={onPositionChange}
    disabled={disabled}
  />
)}
```

3. Form state holds the focal point: `src/hooks/use-event-form.ts:31-32, 49-50, 102` - `cover_image_position_x` / `cover_image_position_y` default 50.

4. Persistence is wired in both create and edit:
   - `src/pages/events/create-event.tsx:1641-1642` (read on prefill from source event), `:1754-1755` (write to insert payload), `:1982-1983` (pass to `<CoverImageFields>`).
   - `src/pages/events/edit-event.tsx:85-86` (read), `:142-143` (write), `:357-358` (pass to picker).

5. Schema columns exist on `events`: `src/types/database.types.ts:2986-2987` Row, `:3012-3013` Insert, `:3038-3039` Update. Both `number` (not nullable on Row).

6. Render path uses `coverImagePositionStyle(positionX, positionY)`:
   - Live preview in the form: `src/pages/events/components/event-form-fields.tsx:218-222` applies `style={{ aspectRatio: '16/9', ...coverImagePositionStyle(positionX, positionY) }}`.
   - Home page Next Event card: `src/pages/home.tsx:438-439` passes through to `Card.Overlay`.
   - Home page upcoming events carousel: `src/pages/home.tsx:530-531`.
   - Home page national events: `src/pages/home.tsx:643-644`.
   - Events index page: `src/pages/events/index.tsx:298-299`.

7. Home feed query selects the columns explicitly: `src/hooks/use-home-feed.ts:209` - `'id, title, date_start, date_end, address, cover_image_url, cover_image_position_x, cover_image_position_y, collective_id, status'`.

8. Helper applies the CSS: `src/lib/cover-image.ts:15-22` returns `{ objectPosition: '${xv}% ${yv}%' }` with 50/50 fallback for null/undefined.

Verified shipped at `src/components/cover-image-focal-point-picker.tsx` + the eight call-sites above on commit ca04c31 (2026-04-28 22:18 AEST). End-to-end: upload -> position state -> picker UI -> debounced onChange -> form state -> insert/update with both columns -> render with `objectPosition`. Working as specified.

---

## Item 3 - Home page upcoming-events-of-my-collectives section

**Status: PARTIAL**

The section exists, queries the right data, and renders with focal-point support. But the section ordering does NOT match Tate's spec - the brief says "rendered between the Impact section and the Next Event card" and currently those two anchor sections have two other sections (National Events, Updates) in between them.

**Evidence:**

1. The carousel component exists and is wired to a query that returns events for collectives the user is a member of. `src/pages/home.tsx:482-605` (`UpcomingEventsCarousel`). It calls `useCollectiveUpcomingEvents()`.

2. The query is correct - filters to collectives the user is an active member of, future-only, published, ordered by `date_start` ascending, limit 10. `src/hooks/use-home-feed.ts:432-466`:

```ts
const { data: memberships } = await supabase
  .from('collective_members')
  .select('collective_id')
  .eq('user_id', user.id)
  .eq('status', 'active')

const collectiveIds = (memberships ?? []).map((m) => m.collective_id)
if (collectiveIds.length === 0) return []

const { data, error } = await supabase
  .from('events')
  .select('*, collectives(id, name)')
  .in('collective_id', collectiveIds)
  .eq('status', 'published')
  .or(`date_start.gte.${nowIso},date_end.gte.${nowIso}`)
  .order('date_start', { ascending: true })
  .limit(10)
```

3. **Section order on the home page does NOT match the brief.** Current top-to-bottom order in `src/pages/home.tsx:1126-1184`:

   1. ProximityCheckInBanner (`:1128`)
   2. PendingSurveys banner if any (`:1131-1157`)
   3. **NextEventCard** (`:1160-1165`)
   4. **UpcomingEventsCarousel** (`:1168`) - this IS the "upcoming events of my collectives" section
   5. NationalEventsSection (`:1171`)
   6. UpdatesSection (`:1174`)
   7. **HomeImpactSection** (`:1177-1181`)
   8. CtaCards (`:1184`)

   Tate's spec: "rendered between the Impact section and the Next Event card". The literal reading is that the carousel should sit ADJACENT to both the Impact section and the Next Event card with nothing else between. Currently the carousel IS in that interval, but two other sections (National Events at #5, Updates at #6) are also in that interval. Either Tate wants the order to be `NextEvent -> UpcomingEvents -> Impact -> ...` (collapse the two sections out of that span) or `Impact -> UpcomingEvents -> NextEvent -> ...` (full reorder with Impact moved to the top).

4. The carousel renders covers with focal-point support via `Card.Overlay` and the `cover_image_position_x` / `cover_image_position_y` props at `src/pages/home.tsx:530-531` - so visually it inherits the events focal-point work from item 2.

**Fix proposal (1 paragraph, audit-only - do not implement in this fork):**

The carousel and query are already correct. Only the home-page section ordering needs to change. Two interpretations - confirm with Tate before shipping. **Option A (minimum-change, most likely intent):** in `src/pages/home.tsx:1126-1184`, move `<NationalEventsSection rm={rm} />` and `<UpdatesSection rm={rm} />` to AFTER `<HomeImpactSection .../>`, so the order becomes NextEvent -> UpcomingEventsCarousel -> Impact -> National -> Updates -> CTA. This puts UpcomingEventsCarousel directly between NextEvent (above) and Impact (below). **Option B (literal reorder per the brief's "Impact -> Upcoming -> NextEvent" reading):** flip the order entirely so Impact is at the top, UpcomingEventsCarousel second, NextEventCard third, then everything else. Option A is the smaller, safer change and probably matches what Tate meant. Option B materially changes the home-feed reading order and should not ship without an explicit confirmation. Either way it is a 1-section-move edit, not a feature build.

---

## Item 4 - Home page Next Event Card mobile full-width

**Status: SHIPPED**

The Next Event Card on mobile is already full-width within the page container, with small horizontal page padding via `px-4`.

**Evidence:**

1. The body content wrapper for the home feed is `src/pages/home.tsx:1122`:

```tsx
<motion.div
  className="px-4 sm:px-6 lg:px-8 space-y-10 pb-24 mt-4"
  ...
```

   On mobile (< sm/640px) the horizontal padding is `px-4` = 16px each side. On `sm` it goes to `px-6`, on `lg` to `px-8`. This matches "small side padding" on mobile.

2. The `NextEventCard` itself wraps in a width box at `src/pages/home.tsx:420`:

```tsx
<div className="sm:max-w-lg">
```

   `sm:max-w-lg` only applies at the `sm` breakpoint and up. On mobile there is no `max-w-*`, so the card is `width: 100%` of its parent (the `px-4` body wrapper).

3. The card itself does NOT add any internal horizontal margin. `src/pages/home.tsx:423-430` (cover-image variant) and `:446-462` (gradient fallback variant) - both render full-bleed inside the `sm:max-w-lg` wrapper.

4. The check: parent has `px-4` (16px sides), child has no `max-w-*` on mobile and no internal `mx-*` constraint, so the card renders full-width with 16px left + 16px right page padding. Matches the brief.

Verified shipped at `src/pages/home.tsx:420` + `:1122` on commit ca04c31 (2026-04-28 22:18 AEST). No code change needed.

---

## Recommended next forks (if gaps)

1. **Ship collective focal-point parity (Item 1).** Single fork against `coexist-fe`. Mirror the events pattern in `src/pages/admin/collective-detail.tsx` SettingsTab, then update the four collective render sites (admin hero, admin grid, public page, member detail) to apply `coverImagePositionStyle`. Verify queries select the position columns. Non-trivial multi-file edit - dispatch with Factory or fork, not main.

2. **Reorder home page sections (Item 3).** Single small fork. Move `<NationalEventsSection>` and `<UpdatesSection>` to after `<HomeImpactSection>` in `src/pages/home.tsx:1126-1184`. **Confirm Option A vs B with Tate first** before dispatching - the brief is ambiguous and Option B is a much larger UX change.

3. **Optional follow-up: collective hero alt text + image dimensions audit.** Several collective `<img>` tags above use only `alt={detail.name}` or no alt. Once focal-point is wired, do a small a11y/perf pass on the same files (lazy loading, decoding=async, width/height attrs).

---

## Summary table

| Item | Status | Files touched (proposed fix) |
|---|---|---|
| 1. Collective focal-point | MISSING | `src/pages/admin/collective-detail.tsx`, plus 4 collective render sites + queries |
| 2. Event focal-point | SHIPPED | none (verified at `src/components/cover-image-focal-point-picker.tsx` + 8 call-sites) |
| 3. Home upcoming-of-my-collectives between Impact and NextEvent | PARTIAL | `src/pages/home.tsx:1126-1184` (section reorder only) |
| 4. NextEventCard mobile full-width | SHIPPED | none (verified at `src/pages/home.tsx:420` + `:1122`) |

Two SHIPPED, one PARTIAL (ordering), one MISSING (collective parity). No code changed in this fork - audit-only per brief.
