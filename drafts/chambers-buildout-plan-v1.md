# Chambers Buildout Plan v1

**Fork:** fork_moi8x4f5_4905b6
**Date:** 2026-04-28
**Codebase:** `~/workspaces/chambers/fe` (registered as `chambers-frontend`)
**Supabase project:** `arkbjjkfjsjibnhivjis`
**Tenants seeded:** `scycc` (tenant 0), `samplechamber` (proof-of-multi-tenancy)

---

## Architectural Invariants (NON-NEGOTIABLE for every dispatch)

Every Wave 1 dispatch begins with these in its first paragraph:

1. Multi-tenant from line 1. No hardcoded SCYCC names anywhere except seed JSON / seed SQL.
2. Tenant resolution by hostname (subdomain or custom domain mapped to a `tenants` row). FE: `TenantProvider` already does this. Any new server-side surface MUST resolve via hostname header, not request body.
3. RLS on every tenant-scoped table. Reads on sensitive tables (directory, members-with-contact, sponsors-with-contracts) gated to `is_member_of(tenant_id)` or `is_officer(tenant_id)`. Cross-tenant query risk = P1.
4. Brand theming via CSS custom properties per-tenant (`--color-primary` etc). No global brand stylesheet.
5. Admin surface tenant-scoped. Auth tenant-aware (one `auth.users` row can hold rows in `tenant_members` for multiple tenants).
6. Per-tenant customisation surface via `/admin/branding`: logo upload to `tenant-assets/${tenant_id}/`, colour pickers, hero copy, contact info, social links, SEO meta. Persisted to `tenants` (already shipped) — extend, don't fork.
7. Acceptance: a SECOND tenant addable in <30 min via `tenants` row + brand config + seed JSON + DNS. No code changes.
8. Seed data plural-capable: every seed file must seed BOTH SCYCC and Sample Chamber so the abstraction is provably general.

## Deploy Verify Gate (NON-NEGOTIABLE for every dispatch)

Every Factory dispatch ends with the Deploy Verify block (template at the bottom of this file). Session is incomplete until Vercel deployment state == READY and Puppeteer verification of 3+ routes passes for BOTH `scycc` (default) and `?tenant=samplechamber`.

---

## Current State (audit per route)

### Public routes
- `/` **Home** — SHIPPED. Renders hero, mission, values, upcoming events, contact, social. Pulls everything from `tenants`, `tenant_values`, `tenant_events`. Tenant-scoped via `useTenant()`. Solid.
- `/events` **Events** — SHIPPED. List from `tenant_events`, RSVP counts via trigger. Status filter not surfaced; shows all events regardless of `status` (draft/published).
- `/events/:id` **EventDetail** — SHIPPED. RSVP/UnRsvp gated correctly: must be active member. Past-event detection works. Stripe ticketing for paid events not present (capacity column exists but not surfaced; no `price_cents`).
- `/members` **Members** — PARTIAL. Renders `tenant_team` (officers) + `tenant_membership_tiers` (pricing grid). "Join as X" button just links to `tenant.website_url + '/membership'` — it is NOT a Stripe checkout. The page name is also misleading; this is "Team & Tiers", not a member directory.
- `/resources` **Resources** — STUB. `useTenantResources` hook exists, page does NOT call it. Renders a placeholder card "coming soon" + 4 hardcoded social-link cards. Real `tenant_resources` rows are never displayed.
- `/profile` **Profile** — SHIPPED. Apply for membership (insert pending), edit name/business, sign out. RLS self-write correctly enforced.
- `/signin` **SignIn** — SHIPPED. Email+password.
- `/signup` **SignUp** — SHIPPED.
- `/tenant-not-found` **TenantNotFound** — SHIPPED (16 lines, fallback for unknown subdomain).

### Admin routes (officer-gated via `AdminLayout` → `is_officer()` check)
- `/admin` **Dashboard** — SHIPPED but THIN. 3 stat cards: active members, pending applications, upcoming events. No engagement metrics, no time-series, no per-event drilldown.
- `/admin/events` **EventsAdmin** — SHIPPED. Full CRUD with title/description/dates/location/capacity/status, optimistic UI.
- `/admin/members` **MembersAdmin** — SHIPPED. Approve / reject / deactivate. No bulk actions, no search, no role escalation UI.
- `/admin/committees` **CommitteesAdmin** — PARTIAL. CRUD on committees themselves. No UI for `tenant_committee_members` (cannot add a member to a committee). Public-facing committees page does not exist.
- `/admin/branding` **BrandingAdmin** — SHIPPED (505 lines). Logo upload to `tenant-assets/${tenant_id}/`, colour pickers, hero copy, contact, social, SEO meta. Multi-tenant-correct. RLS-gated.

### Schema present
`tenants`, `tenant_team`, `tenant_values`, `tenant_membership_tiers`, `tenant_events`, `tenant_members`, `tenant_event_rsvps`, `tenant_committees`, `tenant_committee_members`, `tenant_resources`. Plus `storage.tenant-assets` bucket with officer-only write policies keyed off path prefix.

### Edge functions present (16) — orphaned
`create-checkout`, `data-export`, `delete-user`, `delete-user-data`, `event-day-notify`, `event-reminders`, `generate-email`, `generate-pdf`, `generate-wallet-pass`, `moderate-content`, `notify-application`, `notify-report`, `send-campaign`, `send-email`, `send-push`, `stripe-webhook`. NONE are called from the FE. The `create-checkout` source even references `coexistaus.org` as default origin — these were copied from coexist as scaffolding and are NOT chambers-aware. Treat as starting code, not as shipped behaviour.

---

## Gap Analysis — what a working chamber-of-commerce platform needs that is not built

These are gaps relative to a federation-ready, paid-second-tenant platform, not nice-to-haves.

| Gap | Severity | Why it matters |
|-----|----------|----------------|
| Member directory (browseable, member-of-tenant gated) | P0 | Networking IS the chamber product. No directory = no value. |
| Member business profile fields (industry, bio, website, phone, linkedin, photo) | P0 | Without these, the directory is empty. |
| Stripe membership checkout (real payment, not external link) | P0 | $397/mo licence assumes the platform itself handles money. |
| Resources page actually rendering `tenant_resources` | P1 | Stubs in production are anti-trust; admin can't preview-because-no-renderer. |
| Notifications on application submit / approve / reject | P1 | Members ghosted = churn. Officers miss apps = pipeline death. |
| Sponsors / Partners surface (table + admin + Home render slot) | P1 | Sponsors ARE the funding model for many chambers. |
| News / Announcements / Member spotlights | P2 | Engagement loop. Currently zero reason to revisit the site after onboarding. |
| Public Committees page | P2 | Committees are visible governance. Admin CRUD without public surface is half-built. |
| Committee members management UI | P2 | Can't actually USE the committee feature. |
| Tenant self-serve onboarding (apply-to-start-a-chamber) | P2 | Federation depends on being able to add tenants without me. |
| Push notifications wired (Capacitor) | P2 | Mobile installed but no notifications fire. |
| Wallet pass / membership card | P3 | Nice-to-have; differentiator. Function exists, no UI. |
| Event ticketing for paid events | P3 | Not core for v1; chambers usually run RSVP-only. |
| Search across members/events | P3 | Helpful but not blocking MVP. |
| Officer analytics dashboard expansion | P3 | The 3 cards are enough for v1. |
| RLS read-tightening on sensitive tables (directory, sponsors w/ contracts, future paid-only resources) | P0 (becomes P0 the moment directory ships) | All current `*_public_read` policies are wide-open. New sensitive tables MUST scope reads to `is_member_of(tenant_id)`. |

---

## Wave 1 — top 5 dispatches (skeleton → MVP)

Each is a Factory-ready prompt with explicit invariant block + acceptance criteria + deploy-verify gate. Order is independent — dispatched in parallel.

### W1.1 — Member Directory (member-of-tenant gated)
- New `/directory` route (renamed semantics: `/members` keeps team+tiers, `/directory` is the browseable list).
- Schema migration `0004_member_profile_extension.sql`: add `industry`, `bio`, `website`, `phone`, `linkedin_url`, `photo_url` to `tenant_members`.
- New helper `is_member_of(_tenant_id uuid)` mirroring `is_officer()`.
- New RLS policy `tenant_members_directory_read` gating SELECT on members where `status='active'` AND (caller `is_member_of(tenant_id)` OR `is_officer(tenant_id)`).
- Drop the broad `tenant_members_public_read` policy if present.
- Officer-edit profile fields (in `MembersAdmin` detail) AND member self-edit (in `Profile`).
- Public route shell that says "sign in as a member to view" if RLS denies.
- Acceptance: switching `?tenant=samplechamber` shows ZERO SCYCC members, and vice versa, regardless of caller's tenant. Logged-out anon sees zero rows.

### W1.2 — Resources page wired + Resources admin
- Replace `Resources.tsx` stub with real render of `useTenantResources` rows. Empty state stays only when zero rows.
- New `/admin/resources` route + `ResourcesAdmin.tsx` with CRUD (title, description, url, icon, sort_order).
- New mutation hooks `useUpsertResource` + `useDeleteResource` in `lib/db/hooks.ts`.
- Add nav item in `AdminLayout`.
- Seed both `scycc` AND `samplechamber` with 3 resource rows each in a new seed file.
- Acceptance: SCYCC resources differ visually from Sample Chamber resources after switching tenant; admin CRUD round-trips persist.

### W1.3 — Stripe membership checkout (real payment)
- Schema: add `stripe_price_id` (text, nullable) and `stripe_product_id` (text, nullable) to `tenant_membership_tiers`. Add `tenant_stripe_connect` table with `tenant_id`, `stripe_account_id`, `connect_status` for per-tenant Stripe Connect (or a flag if first version uses platform Stripe with metadata-tagged tenant).
- New edge function `chambers-create-membership-checkout` that takes `{ tier_id, return_url }`, resolves tenant via JWT/auth, calls Stripe `checkout.sessions.create` with `tenant_id` and `tier_id` in metadata.
- Refactor `create-checkout` orphan: delete or replace, do NOT leave coexist-origin code in repo.
- New edge function `chambers-stripe-webhook` that handles `checkout.session.completed` → upserts `tenant_members` to `status='active'` for that user/tenant, records `tier`.
- FE: `Members.tsx` "Join as X" button now calls the edge function and redirects to checkout url.
- Auth gate: must be signed in before checkout (redirect to `/signin?next=...`).
- For v1, single-Stripe-account-with-metadata is acceptable; document the Connect upgrade path in code comments.
- Acceptance: Stripe test card payment on SCYCC tier puts SCYCC member to `active`. Same payment on Sample Chamber tier creates a SEPARATE active row scoped to Sample Chamber tenant. Webhook signature verified.

### W1.4 — Notifications (application submit / approve / reject / event reminders)
- Refactor `notify-application` edge function to be tenant-aware: accepts `{ tenant_id, member_id, event }`, fetches officer emails via `tenant_members where role in (officer,admin,president) and status=active`, sends via Resend (or whatever's already wired in the orphaned `send-email` function).
- Trigger from `useApplyMembership` `onSuccess` via supabase RPC or direct fetch.
- New trigger from `useUpdateMemberStatus` (approve / reject) → email applicant via the same function.
- Refactor `event-reminders` edge function to be tenant-aware. Cron via Supabase scheduled functions, runs nightly, finds events with `starts_at` in next 24h, emails RSVPed members.
- Acceptance: applying for membership on SCYCC sends email to SCYCC officers ONLY (no Sample Chamber leak). Approving/rejecting emails the applicant. Event reminder cron runs and only emails for events of the correct tenant.

### W1.5 — Sponsors (table + admin + Home render slot)
- Schema migration `0005_sponsors.sql`: `tenant_sponsors` table (id, tenant_id, name, logo_url, url, tier text, sort_order, active boolean, created_at). RLS: public read (logos are intentionally public on a chamber site); officer write.
- New admin route `/admin/sponsors` + `SponsorsAdmin.tsx` with CRUD + logo upload to `tenant-assets/${tenant_id}/sponsors/`.
- Add `useTenantSponsors`, `useUpsertSponsor`, `useDeleteSponsor` hooks.
- Render slot on Home page between Mission and Values: "Our Sponsors" with logo grid grouped by tier (Platinum/Gold/Silver/Community defaults).
- Seed 3 sponsors for SCYCC AND 3 for Sample Chamber so the multi-tenant render is provable.
- Acceptance: SCYCC home shows SCYCC sponsors; Sample Chamber home shows Sample Chamber sponsors; admin CRUD round-trips.

---

## Wave 2 — next 5 (after Wave 1 lands)

1. **News / Announcements / Member Spotlights** — `tenant_announcements` table, `/news` public route + `/admin/news` CRUD, render latest 3 on Home below Sponsors.
2. **Public Committees page + Committee member management** — `/committees` public route, extend CommitteesAdmin with add/remove members UI using `tenant_committee_members`.
3. **Tenant self-serve onboarding** — public `chambers.app/start` form → creates `pending` row in new `tenant_applications` table → super-admin (Ecodia) review → activation creates tenant + first officer + DNS hint.
4. **Push notifications via Capacitor** — wire `@capacitor/push-notifications`, register tokens in `tenant_member_devices` table, refactor `send-push` edge function to be tenant-aware, send on event-day and approval.
5. **Officer analytics dashboard expansion** — RSVP trend, member growth, application time-to-decision, top-attended events. Time-series queries scoped to tenant.

---

## Risks

1. **Stripe Connect vs platform-Stripe-with-metadata.** W1.3 ships v1 with platform Stripe and `tenant_id` metadata. This works for our take-rate model but means every tenant's revenue lands in OUR Stripe and we have to pay them out. Connect is the right answer long-term but is a 2-week build. Tate decision needed before W1.3 dispatch finishes — see Tate decisions section below.
2. **Read-policy tightening risk.** Currently `tenant_members_public_read` is wide-open. The directory dispatch (W1.1) drops this and replaces it with `is_member_of`-gated read. If anything else in the FE was relying on anonymous reads of members, it will silently break. Audit shows only `useTenantMembers` (officer-only path) and `useMyMember` (auth.uid scoped) call this table from FE — both are fine. But verify in deploy-verify Puppeteer pass.
3. **Email deliverability.** `send-email` edge function exists but its provider is unverified (could be Resend, SendGrid, or stubbed). W1.4 dispatch must check actual configuration and either reuse or wire Resend with `RESEND_API_KEY` from Supabase vault. If the secret isn't there, dispatch will be blocked pending creds — flag it in the prompt as a degradation path: log + skip, do not crash.
4. **Vercel project naming.** Repo is `chambers-frontend`. Verify `.vercel/project.json` is wired before any dispatch runs; if not, dispatch must `vercel link --project=chambers-frontend` non-interactively.
5. **Cross-tenant leak in edge functions.** All 16 orphan functions ignore `tenant_id`. Wave 1 only refactors `create-checkout` and `notify-application` and `event-reminders`. The other 13 stay orphaned with risk of future copy-paste. Wave 2 should triage: rewrite-with-tenant-scope OR delete.

---

## Dependencies

- `tenant_members` schema extension (W1.1) blocks the directory render.
- `is_member_of()` helper (W1.1) is needed before any future member-only read policy.
- Stripe Connect decision (Tate, see below) blocks W1.3 finishing the Connect path; dispatch ships with platform-Stripe v1 and notes the upgrade path.
- Resend / email provider secret in Supabase vault blocks W1.4 finishing. Dispatch must verify before sending; degrade gracefully.
- Vercel project link blocks deploy verify on every dispatch. Verify-once at top of every prompt.

---

## Schema changes summary (Wave 1)

```sql
-- 0004_member_profile_extension.sql
alter table tenant_members
  add column if not exists industry text,
  add column if not exists bio text,
  add column if not exists website text,
  add column if not exists phone text,
  add column if not exists linkedin_url text,
  add column if not exists photo_url text;

create or replace function is_member_of(_tenant_id uuid)
returns boolean language sql stable security definer
set search_path = public as $$
  select exists (
    select 1 from tenant_members
    where tenant_id = _tenant_id and user_id = auth.uid() and status = 'active'
  );
$$;
grant execute on function is_member_of(uuid) to anon, authenticated;

drop policy if exists tenant_members_public_read on tenant_members;
create policy tenant_members_directory_read on tenant_members
  for select using (
    status = 'active' and (is_member_of(tenant_id) or is_officer(tenant_id))
  );
-- Plus self-read so /profile still works
create policy tenant_members_self_read on tenant_members
  for select using (user_id = auth.uid());

-- 0005_sponsors.sql
create table if not exists tenant_sponsors (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  logo_url text,
  url text,
  tier text default 'community',
  sort_order integer default 0,
  active boolean default true,
  created_at timestamptz default now()
);
alter table tenant_sponsors enable row level security;
create policy tenant_sponsors_public_read on tenant_sponsors for select using (true);
create policy tenant_sponsors_officer_write on tenant_sponsors for all
  using (is_officer(tenant_id)) with check (is_officer(tenant_id));

-- 0006_membership_stripe.sql
alter table tenant_membership_tiers
  add column if not exists stripe_price_id text,
  add column if not exists stripe_product_id text;
```

---

## What Tate needs to decide before Wave 2

1. **Stripe model.** Platform-Stripe-with-metadata (we hold money, pay tenants out) vs Stripe Connect Express (each tenant has their own Stripe, we take a fee). v1 ships platform-Stripe; Connect is a Wave 2/3 upgrade. Tate: which.
2. **Federation tenant pricing finalised.** $397/mo licence is the working number. Lock it before we send a real second-tenant proposal. Same IP-retention model as Co-Exist.
3. **Domain strategy for tenants.** Subdomain on `chambers.app` (free, fast) vs custom domain CNAME (slower onboarding, more professional). v1 supports both via `TenantProvider` hostname resolution. Tate: which is the pitch?
4. **Email sender identity for tenants.** Send-as `noreply@chambers.app` vs `noreply@${tenant.domain}` (requires per-tenant DKIM). v1 ships chambers.app; per-tenant DKIM is W2/W3.

---

## Deploy Verify Gate (template injected into every dispatch)

```
DEPLOY VERIFY (non-negotiable):
After final git push:
  1. Identify Vercel project: read .vercel/project.json. Project must be "chambers-frontend".
     If not linked, run: vercel link --yes --project=chambers-frontend (non-interactive).
  2. Poll latest deployment via mcp__business-tools__vercel_list_deployments
     filtered to project=chambers-frontend, then mcp__business-tools__vercel_get_deployment
     until state == READY or ERROR. Max 8 minutes wall clock.
  3. If READY:
       a. curl https://<deployment-url>/ -> expect HTTP 200 and HTML containing tenant.name.
       b. Puppeteer screenshot of /, /events, and /<new-route> on default tenant (scycc).
       c. Puppeteer screenshot of same routes with ?tenant=samplechamber appended.
          Confirm rendered brand colours and content materially differ.
       d. Verify no console errors on either tenant.
  4. If ERROR:
       a. Pull buildLogs via vercel_get_deployment.
       b. Fix root cause in this session, commit, push.
       c. Repeat from step 2. Cap at 5 attempts; surface the failing log block if cap hit.
  5. Session is complete only when state == READY AND multi-tenant verification passes.
```
