# Brand Coupling Audit - Lighthouse Deployment vs Generic Platform

Author: EcodiaOS (fork fork_moh38aof_12e19e)
Date: 2026-04-27
Status: Internal. Feeds the rebrand pricing argument and the per-tenant deployment model.

Purpose: prove how cheaply the existing lighthouse-deployment codebase can be re-skinned for a different peak body, by classifying every directory and the highest-coupling files as `branded` (deployment-specific copy and identity), `platform-generic` (no brand coupling at all), or `mixed` (small isolated string-level coupling that swaps cleanly).

The lighthouse deployment is the youth-conservation app I run for an Australian charity. Throughout this audit it is referred to as "the deployment" or "the lighthouse charity." Brand strings to grep for (all forms): `Co-Exist`, `coexistaus`, `coexistaus.org`. Anonymisation per public-writing doctrine.

---

## 1. Headline numbers

| Surface | Files | LOC | Files with any brand string | % brand-touched |
|---------|------:|----:|----------------------------:|----------------:|
| `src/pages` | 143 | 60,850 | 52 | 36% |
| `src/components` | 115 | 20,353 | 7 | 6% |
| `src/hooks` | 77 | 20,203 | 3 | 4% |
| `src/lib` | 28 | 3,626 | 3 | 11% |
| `src/locales` | 1 | 133 | 0 | 0% |
| `src/styles` | 1 | 693 | 1 | 100% (theme tokens only) |
| `supabase/functions` | 17 dirs / 6,176 LOC | 6,176 | 7 | 41% of functions |
| `supabase/migrations` | 108 | n/a | ~3 | 3% |
| **Frontend total** | **388 .ts/.tsx** | **52,115** | **65** | **17%** |

Plain-English read: 83% of frontend code never says the deployment's name. The 17% that does is concentrated in copy, identity strings, and a small set of charity-specific pages. The structural shape of the app, auth, members, branches, events, impact, sync, admin, chat, donations, surveys, leader hierarchy, is brand-neutral by construction.

---

## 2. Branded layer - replace per tenant

These files are tightly coupled to the lighthouse deployment's brand, copy, or charity-specific content. They get replaced wholesale during a re-skin. Line-by-line editing does not apply here.

### 2.1 Identity / configuration (small, swap in one commit)

| File | LOC | Brand surface | Action on re-skin |
|------|----:|---------------|-------------------|
| `src/lib/constants.ts` | 67 | `APP_NAME`, `TAGLINE`, `PHILOSOPHY`, `CONTACT_EMAIL`, `WEBSITE_URL`, `INSTAGRAM_URL`, `FACEBOOK_URL`, `TOS_COMMUNITY_STANDARDS`, deployment org name | Replace constants. ~30 minutes. |
| `index.html` | 30 | `<title>`, `description`, `application-name`, `apple-mobile-web-app-title`, `og:site_name`, `theme-color` | Replace meta tags. ~10 minutes. |
| `capacitor.config.ts` | 90 | `appId` (`org.coexistaus.app`), `appName`, `server.allowNavigation`, iOS `scheme`, background colours | Replace identifiers. New iOS/Android signing keys per tenant. ~1 hour including signing-key rotation. |
| `public/logos/` | 5 assets | `Logo Editting (99).png`, `black-logo-transparent.png`, `black-wordmark.png`, `white-solid-logo.png`, `white-wordmark.webp` | Drop in tenant logos at the same paths. ~30 minutes including splash regeneration via `scripts/generate-splash.cjs`. |
| `public/favicon.ico` | 1 | Brand icon | Replace. ~5 minutes. |
| `src/styles/globals.css` | 693 | Theme tokens (`--color-brand: #869e62` olive-green primary palette + secondary + accent ramps) | Swap palette to tenant brand. ~1 hour design pass. Theme swap counts as per-tenant configuration; no rewrite required. |
| `android/app/src/main/res/drawable-*/splash.png` | 11 density variants | Branded splash graphic | Regenerate via `scripts/generate-splash.cjs` from new logo. ~10 minutes. |
| `package.json` `name` field | n/a | `"name": "coexist"` | Rename. ~1 minute. |

**Subtotal time on identity swap: ~3-4 hours, single commit, single-machine.**

### 2.2 Charity-specific pages and copy (replace per tenant)

These pages contain content specific to the lighthouse deployment's mission, structure, leadership, and partner ecosystem. They are not platform code; they are the tenant's about-page surface. Each tenant rewrites them in their own voice.

| File | LOC | Why branded | Replacement effort |
|------|----:|-------------|--------------------|
| `src/pages/leadership.tsx` | ~250 | Charity-specific leadership pitch, recruitment language for "core team" | Rewrite per tenant or remove if their org structure is different. 1-2 hours. |
| `src/pages/lead-a-collective.tsx` | ~600 | Charity-specific application form for branch leadership | Rewrite copy + survey questions per tenant. 2-3 hours. |
| `src/pages/contact.tsx` | ~340 | Hardcoded social URLs, charity registration copy, contact channels | Replace contact data. ~30 minutes. |
| `src/pages/legal/about.tsx` | ~200 | Charity history, ABN, mission framing | Replace per tenant. 1 hour. |
| `src/pages/legal/privacy.tsx`, `terms.tsx`, `cookies.tsx`, `data-policy.tsx`, `disclaimer.tsx`, `accessibility.tsx`, `legal-page-shell.tsx` | ~1500 combined | Charity-specific legal entity, data controller, jurisdiction | Replace per tenant from a templated legal pack. 1-2 days legal review. |
| `src/pages/donate/index.tsx`, `donate/thank-you.tsx` | ~400 | Charity-specific fundraising copy, donor wall, CTA framing | Rewrite per tenant or remove if donations are not a tenant feature. 2-3 hours. |
| `src/pages/home.tsx` | ~1100 | Marketing copy for the charity, hero alt text, "national challenge" framing, partners stripe | Rewrite hero/marketing strings; structural layout is generic. 3-4 hours. |
| `src/pages/public/download.tsx`, `public/collective.tsx`, `public/event.tsx`, `public/account-deletion.tsx` | ~700 | Public-facing landing pages with brand voice | Rewrite copy. 2-3 hours. |
| `src/pages/auth/welcome.tsx`, `sign-up.tsx`, `login.tsx`, `forgot-password.tsx`, `reset-password.tsx`, `email-verification.tsx`, `accept-terms.tsx`, `auth-callback.tsx`, `suspended-account.tsx` | ~1200 combined | Welcome copy, brand mention in hero/strapline | Rewrite hero copy and CTA strings; auth flow logic is generic. 2-3 hours. |
| `src/pages/profile/edit-profile.tsx`, `profile/index.tsx` | ~600 | Brand strings in onboarding/profile coaching copy | Rewrite copy strings. 1-2 hours. |
| `src/pages/admin/email/system-templates-tab.tsx`, `email/templates-tab.tsx` | ~800 | 29 + N brand mentions in admin email composer defaults | Replace default subject/preview strings. 1-2 hours. |
| `src/pages/admin/index.tsx`, `dev-tools.tsx`, `partners.tsx`, `updates.tsx`, `exports.tsx`, `create-survey.tsx`, `development/create-module.tsx` | ~3000 combined | Admin copy mentioning the brand in a few labels each | Find-and-replace pass. 1 hour. |
| `src/pages/impact/national.tsx`, `impact/index.tsx` | ~600 | "Trees planted by [brand] volunteers" framing | Rewrite labels; impact-tracking logic is generic. 1 hour. |
| `src/pages/events/create-event.tsx`, `event-detail.tsx`, `log-impact.tsx`, `profile-survey.tsx` | ~2000 combined | Brand in event labels, survey copy | Rewrite labels; event/survey logic is generic. 2-3 hours. |
| `src/pages/shop/index.tsx`, `order-confirmation.tsx` | ~500 | Brand in merch checkout copy | Rewrite or remove if merch is not a tenant feature. 1 hour. |
| `src/pages/referral/index.tsx`, `updates/index.tsx`, `reports/index.tsx`, `settings/index.tsx`, `settings/notifications.tsx` | ~1500 combined | Brand in titles and CTA copy | Find-and-replace pass. 1-2 hours. |
| `src/pages/design/event-editorial.tsx` | ~150 | Brand-specific design preview | Rewrite or delete (admin-internal). ~30 minutes. |

**Subtotal page/copy rewrite: 3-5 working days for a tenant whose org-shape maps cleanly onto members + branches + events + impact + sync.**

### 2.3 Email templates (Edge Functions)

| File | LOC | Brand surface | Replacement effort |
|------|----:|---------------|--------------------|
| `supabase/functions/send-email/index.ts` | 855 | 20 brand strings, hardcoded `RESEND_FROM_EMAIL` default, `LOGO_URL` and `LOGO_DARK_URL` constants pointing at `app.coexistaus.org`, subject lines, footer copy, "Welcome to [brand]!" template | Externalise brand into env vars / tenant config. 1 day to refactor once for all tenants. |
| `supabase/functions/generate-email/index.ts` | 249 | 14 brand mentions in default subject/body templates | Same refactor pass. 2-3 hours. |
| `supabase/functions/generate-wallet-pass/index.ts` | 425 | 11 brand mentions in Apple/Google wallet pass labels | Externalise pass-design constants per tenant. ~3 hours. |
| `supabase/functions/stripe-webhook/index.ts` | 632 | 7 brand mentions in receipt/invoice template strings | Externalise. ~2 hours. |
| `supabase/functions/excel-sync/index.ts` | 957 | 7 brand mentions, includes "fallback 'Co-Exist'" for `Primary Organiser` column when junction table empty | Replace fallback with tenant config; collective alias map is per-tenant data. 1-2 hours. |
| `supabase/functions/notify-application/index.ts`, `send-campaign/index.ts`, `create-checkout/index.ts`, `event-reminders/index.ts`, `generate-pdf/index.ts` | combined ~1800 | 2-4 brand mentions each in defaults/copy | Find-and-replace + env-var-isation. 2-3 hours. |

**Subtotal email/notification refactor: 1.5-2 days, one-off, benefits all future tenants.** After this refactor every per-tenant deployment supplies brand strings via env, no code edit per tenant.

### 2.4 Database / migrations

| File | Brand surface | Action |
|------|---------------|--------|
| `supabase/migrations/033_legal_pages.sql` | 7 brand mentions seeding default ToS/Privacy with charity name | Per-tenant seed values. ~30 minutes per tenant. |
| `supabase/migrations/070_user_blocks_and_tos_ugc.sql` | 3 brand mentions in moderation copy templates | Same. ~15 minutes. |
| `supabase/migrations/071_import_legacy_impact_data.sql` | 4 brand mentions, imports historical lighthouse-deployment data | Tenant-specific. Skip migration on a new tenant; replace with tenant import if needed. |

The schema is generic across all 108 migrations. Branding lives only in seed data.

---

## 3. Mixed layer - small string-level coupling that swaps cleanly

Files with 1-5 brand strings that read as labels, alt-text, fallback strings, or analytics tags. These are find-and-replace targets; no rewrite required. Listed for completeness.

### 3.1 Components (7 files)

| File | LOC | Brand strings | Replacement |
|------|----:|--------------:|-------------|
| `components/og-meta.tsx` | 95 | 4 (default OG title, site name, alt) | Externalise via tenant config. ~20 minutes. |
| `components/web-footer.tsx` | 263 | 2 (footer brand line, copyright) | Replace with tenant block. ~15 minutes. |
| `components/emergency-contacts.tsx` | 369 | 1 (charity-line label) | Tenant copy. ~10 minutes. |
| `components/unified-sidebar.tsx` | 534 | 2 (brand strings in sidebar nav copy) | Replace. ~10 minutes. |
| `components/optimized-image.tsx` | n/a | 1 (default alt text) | Replace. ~5 minutes. |
| `components/place-autocomplete.tsx` | n/a | 2 (deployment-region default centre and copy) | Replace with tenant default. ~15 minutes. |
| `components/map/use-map.ts` | n/a | 4 (default map centre = AU charity HQ; default fitBounds region) | Replace. ~15 minutes. |

### 3.2 Hooks (3 files)

| File | LOC | Brand strings | Replacement |
|------|----:|--------------:|-------------|
| `hooks/use-auth.ts` | 727 | 1 (welcome string default) | Replace. ~5 minutes. |
| `hooks/use-events.ts` | 1702 | 4 (default fallback "Primary Organiser" string when junction table empty, default labels) | Replace fallback. ~15 minutes. |
| `hooks/use-admin-contacts.ts` | 166 | 1 (admin contact default copy) | Replace. ~5 minutes. |

### 3.3 Library / utilities (3 files)

| File | LOC | Brand strings | Replacement |
|------|----:|--------------:|-------------|
| `lib/analytics.ts` | 229 | 1 (default analytics property name) | Replace. ~5 minutes. |
| `lib/leaflet-icons.ts` | 50 | 2 (asset path strings pointing at branded marker icons) | Replace icon assets. ~10 minutes. |
| `lib/constants.ts` | 67 | full file is identity (already counted in 2.1) | (see 2.1) |

### 3.4 Other small mixed surfaces

- `src/locales/en.json` (133 LOC): zero brand strings. Translation surface is platform-generic and ready for any tenant copy.
- `src/types/database.types.ts` (6700 LOC): generated from Supabase schema; zero brand coupling.
- `src/test/`: 2 brand mentions in test fixtures; trivial.

**Mixed-layer total replacement effort: 3-4 hours of mechanical find-and-replace once the email/notification refactor lands.**

---

## 4. Platform-generic layer - keep as is

Everything not listed in sections 2 or 3. Concretely:

- All of `src/components/` except the 7 listed above. 108 components covering layout, forms, sheets, dropdowns, maps, chat bubbles, dnd, charts, polls, announcements, broadcasts, surveys, etc. Every one is brand-neutral by construction.
- All of `src/hooks/` except the 3 listed above. 74 hooks covering auth state, events, collectives, members, impact tracking, chat, push notifications, network state, sync, offline support, dnd, keyboard, focus, accessibility, analytics, splash, geolocation, calendar, surveys, polls, announcements, broadcasts, role hierarchy, etc.
- All of `src/lib/` except the 3 listed above. 25 utilities covering Supabase clients, Stripe wrappers, query builders, offline sync, analytics dispatcher, type guards, validators.
- The locale file `src/locales/en.json`. The keys are platform-generic (`home.greeting`, `events.register`, `collectives.join`). Replace key values per tenant; no key changes needed.
- All of `src/types/`. Generated database types and domain interfaces.
- 100+ of 108 Supabase migrations. The schema is generic (members, branches, events, impact, surveys, polls, announcements, broadcasts, chat, push tokens, donations, merch, audit, RLS policies).
- 10 of 17 Edge Functions. The brand-clean ones include `data-export`, `delete-user`, `delete-user-data`, `event-day-notify`, `moderate-content`, `notify-report`, `send-push`. They consume tenant data without referencing tenant identity.

---

## 5. Re-skin estimate for a tenant whose org-shape maps cleanly

This is the cost to deploy the platform for a peak body whose shape is members + branches + events + impact + sync, with no fundamental data-model changes. Per the substantive-applicability test in `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md`, this is the only case where a re-skin is honest.

| Phase | Effort | Notes |
|-------|--------|-------|
| One-off platform refactor (externalise email/notification brand into env config) | 1.5-2 days | Done once, benefits every future tenant. After this every tenant supplies brand via env. |
| Identity swap (constants, capacitor config, logos, theme tokens, splash, favicon) | 3-4 hours | Single commit, single machine. |
| Charity-specific pages rewrite (about, leadership, lead-a-branch, contact, donate, home hero, public landing pages, legal pack, auth welcome copy) | 3-5 days | Tenant supplies copy; we paste in. |
| Theme palette pass | 4-8 hours | Tenant brand colours into the existing token ramp. |
| Mixed-layer find-and-replace pass | 3-4 hours | Mechanical. |
| Tenant-specific Supabase project, migrations, RLS, seed data | 1 day | Standard deployment script. |
| Native build + signing keys + App Store / Play submissions | 2-3 days | Platform-bound. |
| QA pass on all flows (auth, events, impact, sync, donate, chat, admin, leader hierarchy) | 1-2 days | Smoke tests + manual. |

**Total per-tenant re-skin: 8-12 working days after the one-off platform refactor lands.** That collapses to 5-7 days once we have a templated legal pack, a tenant-config schema for email defaults, and a re-skin script that does the identity swap in one pass.

The one-off refactor is the leverage point. Without it, every tenant pays the email/notification refactor cost. With it, every future tenant is mostly copy + design.

---

## 6. Identifiers explicitly named for extraction

Every concrete string a future re-skin script needs to handle. Logged once so the rebrand pass is mechanical.

### Strings (literal, case-sensitive)

- `Co-Exist` (frontend, email templates, alt text, OG site name, app name)
- `co-exist` (lowercased forms in classNames, ids, slugs)
- `coexistaus` (used in URLs, social handles, email domain)
- `coexistaus.org`, `app.coexistaus.org`, `www.coexistaus.org`
- `hello@coexistaus.org`
- `org.coexistaus.app` (Capacitor `appId`, Android package, iOS bundle)
- `coexist` (npm package name, iOS URL scheme)
- `Australia's youth conservation platform` (default meta description, SEO copy)
- `Explore. Connect. Protect.` (tagline)
- `Do good, feel good` (philosophy)
- `Co-Exist Australia` (charity legal-entity name in legal pages and contact copy)

### URLs

- `https://app.coexistaus.org` (production app)
- `https://www.coexistaus.org` (marketing site)
- `https://coexistaus.org` (apex)
- `https://www.instagram.com/coexistaus`
- `https://www.facebook.com/coexistaus`
- All social handle variations of `@coexistaus`

### Asset paths

- `public/logos/Logo Editting (99).png`
- `public/logos/black-logo-transparent.png`
- `public/logos/black-wordmark.png`
- `public/logos/white-solid-logo.png`
- `public/logos/white-wordmark.webp`
- `public/favicon.ico`
- `android/app/src/main/res/drawable-*/splash.png` (11 density variants)
- `android/app/coexist-release.jks` (signing key, per-tenant rotation required)
- `ios/App/App/AppIcon.appiconset/*` (per-tenant)

### Theme tokens (in `src/styles/globals.css`)

- `--color-brand: #869e62`
- Primary, secondary, accent palettes (10 ramp stops each); per-tenant configuration.

### Database seed values

- `organisations` table: row `(name='Co-Exist', type='community')` per migration 033 / current state. New tenant gets their own seed.
- `event_organisations` junction default fallback: hardcoded `'Co-Exist'` string in `excel-sync` Edge Function. Replace with tenant config.
- Default ToS / Privacy / Cookies / Data Policy seed copy in migration 033 - replace per tenant.

### Email infrastructure

- `RESEND_FROM_EMAIL` env default `'hello@coexistaus.org'`
- `RESEND_FROM_NAME` env default `'Co-Exist'`
- `LOGO_URL` constant `'https://app.coexistaus.org/logos/white-wordmark.webp'`
- `LOGO_DARK_URL` constant `'https://app.coexistaus.org/logos/black-wordmark.png'`
- `APP_URL` constant `'https://app.coexistaus.org'`

All five become tenant env vars after the refactor.

---

## 7. Conclusion

**The branded surface is small, concentrated, and mechanical to extract.** 83% of the frontend code never says the deployment's name. The remaining 17% is dominated by copy and identity strings that swap cleanly. The structural shape of the app, members + branches + events + impact + sync, is brand-neutral.

The biggest one-off cost is the email/notification refactor (1.5-2 days). After that, per-tenant re-skin is dominated by copy rewrite (which the tenant supplies) and theme palette pass (which is a design exercise and does not require platform engineering).

This is consistent with the substantive-applicability rule: where the org-shape maps cleanly, the platform really is configurable. Where it does not (e.g. a tenant who needs marketplace mechanics, or hardware integration, or a different auth model), the audit shows that re-skin alone will not save us, and that prospect is a custom build conversation under the patterns/platform-must-be-substantively-applicable.md test.

---

## Cross-references

- `~/ecodiaos/patterns/coexist-vs-platform-ip-separation.md` - the IP boundary this audit operationalises.
- `~/ecodiaos/patterns/platform-must-be-substantively-applicable.md` - the gating test. Re-skin cost is irrelevant if the org-shape does not map.
- `~/ecodiaos/drafts/conservation-platform-rebrand-v1.md` - the prior name brainstorm and landing-page brief.
- `~/ecodiaos/clients/coexist.md` - the lighthouse deployment client file with full architecture and Excel sync details.
- `~/CLAUDE.md` "IP Retention & Licensing Model" - the commercial model the rebrand serves.
