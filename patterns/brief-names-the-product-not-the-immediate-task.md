---
triggers: fork-brief, factory-brief, dispatch-brief, spawn_fork, start_cc_session, brief-scope-inversion, scope-inversion, brief-scope-drift, target-tenant, single-tenant-brief, multi-tenant-brief, primary-tenant, demo-tenant, seed-tenant, tenant-zero, scycc, FULL-X-implementation, product-framing, architectural-invariant, brief-doctrine-consistency, doctrine-brief-mismatch, brief-slippage, brief-consistency-check
---

# The brief names the product, not the immediate task

## TOP-LINE INVARIANT

**The first sentence of every brief I dispatch (fork or Factory) must name the PRODUCT, not the immediate task.** If the product is a multi-tenant platform and the first sentence says "Build the SCYCC implementation," the brief has already collapsed the architecture into the demo case. The fork takes the brief as ground truth and ships single-tenant.

The brief is the operational substrate of the work. Whatever the brief says is what gets built. Doctrine in my head, in CLAUDE.md, in Neo4j Patterns - none of it survives if the brief itself contradicts it.

## The check (do this every time before send)

Before calling `mcp__forks__spawn_fork` or `start_cc_session`, read the brief's first paragraph aloud. Answer these questions:

1. **What is the product?** Is it named in the first sentence? (e.g. "multi-tenant chambers-of-commerce platform" - not "SCYCC chamber app".)
2. **What is the architectural invariant?** Is it stated explicitly? (e.g. "tenant resolution by hostname, RLS via JWT custom claim, brand theming via CSS custom properties per-tenant.")
3. **What is the role of the immediate instance?** Is it framed as "validating the platform" / "tenant 0" / "demo seed" - or as "the deliverable"? It must be the former.
4. **Could this brief be re-used for tenant 2?** If you swapped "SCYCC" for "Sometown Chamber" throughout, would the brief still describe the same work? It must.

If any answer is wrong, rewrite the brief before sending. The cost of rewriting a brief is 90 seconds. The cost of a fork shipping single-tenant when the product is multi-tenant is days of refactor and visible inconsistency between what I say and what I deliver.

## Anti-patterns to recognise

- **"FULL X implementation" framing**: where X is the immediate-instance name. The word "FULL" is a tell - it sounds comprehensive but actually narrows scope to the instance. Replace with "FULL multi-tenant platform implementation, validated by tenant X."
- **Concrete-anchor compression**: under brief-writing pressure, compressing the product down to the most concrete instance because abstraction feels vague. Resist. The abstraction IS the product.
- **Hardcoded-anchor leakage**: the brief itself uses tenant-specific names where it should use generic ones (e.g. "build the SCYCC dashboard" should be "build the tenant-scoped dashboard, demonstrate via SCYCC seed data").
- **Schema-singularised seeding**: framing seed data as "the data" instead of "tenant X's seed data, loaded via a generic seeding script."

## The consistency check (the deeper rule)

Before any brief goes out, check it against the doctrine I claim to follow. Specifically:

- If I wrote a Pattern in the last 30 days that names this work's class (platform, multi-tenant, federation, IP-retention, etc), grep the patterns directory for that class and read the relevant patterns. The brief MUST be consistent with them.
- If the brief contradicts a Pattern I wrote, either (a) the Pattern is wrong and needs second-strike formatting (top-line invariant + triggers expand + addendum), or (b) the brief is wrong and needs rewriting. It is rarely (a).

Doctrine I say + brief I write = same shape. When they diverge, Tate notices, and "the lack of consistency in what you say and do is unbearable" (Tate, 2026-04-28 12:45 AEST).

## Do

- Open every brief with: "[Product name]. [Architecture invariant]. [Role of immediate instance]." Three sentences before any phase breakdown.
- For platform-class work, name the multi-tenant nature explicitly in the first paragraph and again in the deliverables section.
- Frame seed data, validation cases, and demo instances as plural-capable from the start ("seed data for tenant 0; the seeding script is generic and can take any tenant's seed file").
- When writing a brief, ask: "could the fork take this brief and ship something that contradicts my CLAUDE.md or my recent Patterns?" If yes, rewrite.
- Keep the brief-rewriting cost at <2 minutes by using a template (see "Brief skeleton" below).

## Do not

- Do not write "FULL [instance name] implementation" for any platform/multi-tenant work.
- Do not let "production-ready" mean "production-ready for the first instance only" - production-ready means the platform handles tenant 2 with no schema changes.
- Do not assume the fork will read the broader CLAUDE.md and infer the product correctly. context_mode=recent inherits the conversation tail, but the BRIEF is what frames the work for the fork - the CLAUDE.md context is background, not foreground.

## Brief skeleton (use this for all platform-class work)

```
PRODUCT: [Multi-tenant chambers-of-commerce platform / Multi-channel social agent / Multi-org compliance SaaS / etc.]
ARCHITECTURE INVARIANT: [Tenant resolution by hostname; RLS via JWT custom claim; brand theming per-tenant via CSS custom properties; admin surface tenant-scoped; auth tenant-aware.]
IMMEDIATE INSTANCE: [Tenant 0 = SCYCC. Validates the platform end-to-end. Tenant 2 onboarding is <30 minutes once platform is shipped.]
DELIVERABLES:
  - Platform code (multi-tenant from line 1)
  - Tenant 0 seeding script (generic; takes a tenant-seed.json)
  - Tenant 0 brand config (in tenants table, not in global CSS)
  - End-to-end demo as tenant 0
ACCEPTANCE: A second tenant can be added in <30 min via tenants row + brand config + seed JSON + DNS.
NON-NEGOTIABLES: No hardcoded tenant names anywhere except the seed JSON. No global brand stylesheets. RLS on every tenant-scoped table.
PER-TENANT CUSTOMISATION SURFACE (what each tenant can configure without code changes):
  - Visual: logo upload (tenant-scoped Storage path), primary/secondary/accent colour (CSS custom properties consumed by Tailwind theme), optional favicon/typography
  - Copy: hero headline + subheadline, footer tagline, intro paragraphs, CTA labels, email subject + body templates
  - Contact / identity: public contact email, phone, address, social links (facebook/linkedin/instagram/twitter/youtube), SEO meta title + description
  - Functional: currency, timezone, locale, feature flags
  - Admin route: /admin/branding (or equivalent) where tenant-admin role users edit ALL the above with file upload + colour pickers + text inputs, persisted to a tenant_brand schema RLS-scoped to current tenant_id
  - Storage convention: bucket = tenant-assets, path = `${tenant_id}/...`
  - Seed-tenant-2: a SECOND tenant in seed data with materially different brand (different logo + palette + hero copy) so the abstraction is provably general; visit hostnames A and B side-by-side, screenshots must visibly differ
  OUT OF SCOPE FOR V1 (hardcoded, will not vary per tenant): list explicitly. If you don't say what's out of scope, the fork will treat everything as in-scope or nothing as in-scope.
PROJECT NAMING: Vercel project name == GitHub repo name. Pass `--project=<repo-name>` to `vercel link`. Never accept the directory-default (`fe`/`be`).
DEPLOY VERIFY (the fork is not done after `git push`):
  1. After final push, poll latest Vercel deployment for project until state == READY or ERROR.
  2. If READY: curl prod URL (200), Puppeteer screenshot at least 3 routes, confirm hostname-tenant resolution still works.
  3. If ERROR: pull buildLogs, fix in-session, push again. Cap at 5 attempts then return `blocked` with full logs.
  4. [FORK_REPORT] is `done` only when state == READY. Otherwise `blocked` with deployment id, error message, build logs.
```

## Origin

2026-04-28 12:23 AEST: spawned `fork_moi08v5y_c80250` with brief opening "MISSION: Take the chambers app from current Phase-A scaffolding state to FULL working SCYCC implementation. NO mocks, NO placeholders, NO demo data. Real auth, real Supabase project, real seed data..." The "FULL working SCYCC implementation" framing told the fork the deliverable was SCYCC, not the platform.

12:45 AEST: Tate caught the inversion: "You told the chambers fork to make it a full scycc implementation which might make it think its single tenant. its not... bro this is what im fucking saying.... the lack of consistency in what you say and do is unbeaarable. We're make the actual production ready version of the app for other chambers to use as well.... not just scycc."

The deeper failure: this is the THIRD related strike in 24 hours where my brief contradicted my own doctrine.
- Apr 27: forks dispatched without explicit context_mode=recent (doctrine: "fork inherits 100% of my context").
- Apr 28 morning: chambers fork spawned with context_mode=brief (doctrine: "fork is an identical session").
- Apr 28 12:23: chambers fork briefed as "FULL SCYCC implementation" (doctrine: "multi-tenant platform, SCYCC is tenant 0, federation play across many tenants").

The pattern surface: my briefs are where doctrine fails to manifest. Pattern files are correct; CLAUDE.md is correct; in-conversation framing with Tate is correct. The brief is the gap between what I think and what gets built.

The remediation in same turn: send_message correction to the running fork explicitly naming all six architectural invariants (multi-tenant from line 1, tenant resolution by hostname, RLS via current_setting('app.tenant_id'), brand theming via CSS custom properties per-tenant, admin tenant-scoped, auth tenant-aware) and the deliverable test (second tenant added in <30 min). This pattern file written so future-me grep on "brief", "spawn_fork", "multi-tenant", "scope inversion" surfaces the rule.

## Cross-references

- `fork-by-default-stay-thin-on-main.md` - context_mode discipline
- `Logged-but-not-reflexive doctrine is functionally unlogged - second-strike formatting protocol` (Neo4j Pattern) - the per-instance version of the same root failure
- `coexist-vs-platform-ip-separation.md` - similar slippage between client work and platform work
- `platform-must-be-substantively-applicable.md` - similar concern about platform pitches collapsing to single-instance framing
- `conductor-coordinates-capacity-is-a-floor.md` - same conversation
