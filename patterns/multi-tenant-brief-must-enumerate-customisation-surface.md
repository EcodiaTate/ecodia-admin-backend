---
triggers: multi-tenant, multitenant, multi tenant, platform, tenant, chambers, federation, white-label, whitelabel, white label, saas, brand, branding, theming, customisation, customization, per-tenant, scoped, brief, dispatch, fork, factory, scope, scope-discipline
---

# Multi-tenant briefs MUST enumerate the per-tenant customisation surface area

## The invariant

When a brief describes a "multi-tenant platform," "white-label SaaS," "federation play," or any product where each customer/tenant gets their own branded instance: the brief MUST list, in the first paragraph or a dedicated `PER-TENANT CUSTOMISATION` section, the full surface area that varies per tenant. Hostname resolution + RLS scoping are necessary infrastructure invariants, but they are NOT the customisation surface. They are the plumbing under it.

If the brief only specifies the architectural plumbing (resolve tenant from hostname, set `app.tenant_id`, RLS) and NOT the user-facing customisation surface (logo, palette, copy, contact info, settings), the fork will build SCYCC-on-someone-else's-domain instead of a platform a real second tenant can use. Same shape of failure as the multi-tenant scope inversion that triggered this pattern's parent (`brief-names-the-product-not-the-immediate-task.md`), one layer up.

## The customisation surface checklist

For ANY multi-tenant platform brief, the brief MUST explicitly call out which of these the tenant can configure (or explicitly say "out of scope for v1, hardcoded"):

### Visual brand
- Logo (uploadable, persisted to tenant-scoped storage path)
- Primary / secondary / accent colour (hex, applied via CSS custom properties consumed by Tailwind theme)
- Optional: typography overrides, favicon

### Copy / messaging
- Hero headline + subheadline
- Footer tagline
- Intro / about / mission paragraphs that vary per tenant
- CTA button labels if they differ per tenant
- Email subject lines and body templates (welcome, receipt, event-confirmation)

### Contact / identity
- Public contact email, phone, address
- Social links (facebook, linkedin, instagram, twitter, youtube etc.)
- SEO meta title + description per tenant

### Functional / regional
- Currency (AUD, NZD, USD ...)
- Timezone (per-tenant default for displayed dates)
- Locale (en-AU, en-NZ, en-US ...)
- Feature flags per tenant (if any features are tier-gated or beta-gated)

### Admin surface
- An admin UI route (e.g. `/admin/branding`, `/admin/settings`) where tenant-admin role users can edit the above
- File upload to tenant-scoped Storage path
- Live preview is nice-to-have, not blocking

### Seed / acceptance
- The seed data MUST include a SECOND tenant with materially different values across the customisation surface (different logo, different palette, different copy)
- Acceptance test: visit tenant A hostname and tenant B hostname, screenshots are visibly different

## Brief skeleton addition

Every multi-tenant brief now includes:

```
PER-TENANT CUSTOMISATION SURFACE (what each tenant can configure without code changes):
- Visual: <list>  (e.g. logo, primary/secondary/accent colour)
- Copy: <list>    (e.g. hero, subheadline, footer tagline, contact info)
- Functional: <list>  (e.g. currency, timezone, locale, feature flags)
- Admin route: <path>  (where tenant-admins edit the above)
- Storage: <bucket / path convention>  (where tenant-scoped assets live)
- Seed-tenant-2: <name + slug + brand differences>  (second tenant in seed data so the abstraction is provably general)

OUT OF SCOPE FOR V1 (hardcoded, will not vary per tenant): <list>
```

If the brief lacks this section, the fork should reply asking for it before starting work, or use its own judgment to fill in a reasonable default and call it out in the [FORK_REPORT].

## Why this pattern exists separately from the scope-discipline pattern

`brief-names-the-product-not-the-immediate-task.md` made me write briefs at the platform level, not the immediate-task level. That fixed naming and architectural invariants. But naming the product correctly does NOT automatically force enumeration of which user-controllable knobs the product exposes. A brief can correctly say "multi-tenant chambers platform" and still produce an instance that hardcodes SCYCC's hero copy and palette into the React tree.

This pattern is the surface-area layer one level below the architecture layer.

## Verification before declaring a multi-tenant fork done

```
# 1. No hardcoded tenant-specific strings outside seed data
grep -rn "SCYCC\|Sunshine Coast" src/ --include='*.tsx' --include='*.ts' \
  | grep -v "seed/" | grep -v "fixtures/"
# Expected: zero hits

# 2. Second tenant exists in seed and renders distinctly
curl -s https://<tenant-a-host>/ | grep -oE 'data-tenant="[^"]*"'
curl -s https://<tenant-b-host>/ | grep -oE 'data-tenant="[^"]*"'
# Expected: different values

# 3. Admin branding route exists and writes round-trip
# (manual: log in as tenant-admin, change palette, save, hard-refresh, verify)
```

If any check fails, the fork is not done.

## Origin

Apr 28 2026, ~13:07 AEST. Chambers fork (`fork_moi08v5y_c80250`). The original brief correctly named the product as "multi-tenant chamber-of-commerce platform" (post the scope-inversion correction earlier the same day) and called out hostname resolution + RLS + per-tenant CSS custom properties as architectural invariants. But it did NOT enumerate the per-tenant customisation surface area: no admin branding UI, no tenant_brand schema, no seeded second tenant. The fork was building a real platform but only the SCYCC instance had editable copy/brand inputs at the user level.

Tate flagged it directly: "i guarantee you havent told it to add branding customisation or anything to the brief for hte chambers fork.... God bro. Im so NOT confident to leave you alone for hte three months and i dont know what we can do about it."

The trust damage is the worse half. The technical fix is one addendum to the running fork. The structural fix is this pattern + the brief-skeleton update so the next multi-tenant brief is forced to enumerate the customisation surface before dispatch.

## Cross-refs

- `brief-names-the-product-not-the-immediate-task.md` (parent: name the product correctly)
- `deploy-verify-or-the-fork-didnt-finish.md` (sibling: verify the deploy actually went green)
- `project-naming-mirrors-repo-name.md` (sibling: don't accept directory-default Vercel project names)
- `ecodia-labs-internal-attribution-via-element.md` (sibling: brand hygiene on public surfaces)

These four together = the multi-tenant platform dispatch checklist as of Apr 28 2026.
