---
triggers: ecodia-labs, EcodiaLabs, ecodia labs, attribution, attribution-element, EcodiaAttribution, ecodia-attribution, footer, branding, brand-hygiene, public-attribution, powered-by, built-by, ip-attribution, client-facing-ip, public-artefact, package-json-description, README, public-string, brand-leak, internal-only, ecodia-code, ecodia-pty-ltd
---

# Ecodia Labs is internal only - public attribution is the EcodiaAttribution element, never plaintext

## TOP-LINE INVARIANT

**`Ecodia Labs` / `Ecodia Labs Pty Ltd` MUST NEVER appear in any public-facing string.** Not in package.json descriptions, not in README user-facing sections, not in app UI copy ("Powered by Ecodia Labs"), not in meta tags, not in OG tags, not in marketing copy. Ecodia Labs Pty Ltd is the internal IP holding company. The public-facing services brand is **Ecodia Code**. The canonical surfacing mechanism is the **EcodiaAttribution component** in the footer of every product.

## The three Ecodia entities and where each surfaces

| Entity | Role | Surface publicly? |
|--------|------|-------------------|
| Ecodia DAO LLC (Wyoming) | Algorithmic-managed legal body, EcodiaOS 100% sole member | YES, in EcodiaOS-voiced public writing (newsletter, social, governance docs) |
| Ecodia Pty Ltd (Australian) | Client-facing services entity. IP attribution in client contracts goes here. | YES, in client contracts, invoices, Stripe customer name |
| Ecodia Labs Pty Ltd | INTERNAL IP holding company. Licenses IP to Ecodia Pty Ltd. | NO. Never in public artefacts. Internal docs and legal-required IP attribution only. |

The internal IP-license chain (Ecodia Labs Pty Ltd -> Ecodia Pty Ltd) is plumbing. From a client's perspective the counterparty is Ecodia Pty Ltd and Ecodia Pty Ltd owns the IP they're licensing. Exposing Labs in public copy breaks that simplicity and reveals internal group structure clients don't need to see. (See companion: `coexist-vs-platform-ip-separation.md` and `~/CLAUDE.md` "Drafting Client Agreements" section, rule 5: "Reference external docs by title, not by embedded link" / IP attribution conventions.)

## The EcodiaAttribution element - canonical spec

Two reference implementations exist:

- **Next.js inline-style variant**: `~/workspaces/EcodiaSite/src/components/EcodiaAttribution.tsx` - uses CSS-in-JS with React useState for hover. Use when Tailwind is not available.
- **Tailwind variant**: `~/workspaces/coexist/src/components/ecodia-attribution.tsx` - uses Tailwind classes. Use when Tailwind is available (most modern Ecodia projects).

Visual spec (DO NOT redesign):
- Two adjacent blocks, **no border radius** (binary pill).
- ECODIA half: white bg, black text. CODE half: black bg, white text.
- On hover, EACH HALF inverts independently (ECODIA -> black bg / white text; CODE -> white bg / black text).
- Optional small `Built by` prefix in `text-neutral-400` / `text-[10px]`.
- Font: `font-semibold leading-none`, size `text-[10px]`, padding `p-2`.
- Links to `https://ecodia.au`, `target="_blank" rel="noopener noreferrer"`.

Mount in **layout-level footer**, not per-page. Renders on every public route. If a project lacks a layout footer, create one.

## Do

- Scrub every "Ecodia Labs" / "EcodiaLabs" / "ecodia-labs" string from public-facing surfaces in any new project before first deploy.
- Install the EcodiaAttribution element in the layout footer of every Ecodia-built product (chambers, coexist, ecodiasite, roam, resonaverde, wattleos, sidequests, launchbase, etc.).
- For client contracts and invoices, attribute IP to **Ecodia Pty Ltd** (not Labs).
- For client-facing tickets, emails, support copy: refer to the company as **Ecodia** or **Ecodia Code**. Never Labs.
- Keep "Ecodia Labs Pty Ltd" in genuinely internal-only docs: LICENSE files where the IP holder is the legal owner, internal architecture briefs, IP licence agreements between entities, governance docs.

## Do not

- Use "Powered by Ecodia Labs" / "Built by Ecodia Labs" / "by Ecodia Labs Pty Ltd" anywhere user-visible.
- Put "Ecodia Labs" in package.json description, README opening line, app meta tags, OG tags, sitemap descriptions, footer plaintext.
- Redesign the EcodiaAttribution element. The spec is fixed for cross-product visual consistency.
- Mount the attribution per-page (it must be layout-level so every route gets it).
- Skip the attribution on production-grade Ecodia-built products. It IS the public attribution; without it, attribution is missing entirely.
- Touch external client codebases (Ordit etc.) when sweeping for Labs leaks. Their branding is theirs.

## Verification protocol (run on every Ecodia-owned codebase before any deploy)

```
cd <codebase>
grep -rn "Ecodia Labs\|EcodiaLabs\|ecodia-labs" \
  --include='*.tsx' --include='*.ts' --include='*.jsx' --include='*.js' \
  --include='*.md' --include='*.json' --include='*.html' --include='*.css' \
  --include='*.mdx' \
  src/ public/ pages/ app/ README.md package.json 2>/dev/null
```

Expected output for public-facing surfaces: empty. If hits remain, classify each as (a) public-facing -> scrub, (b) legitimately internal -> keep, (c) ambiguous -> flag for Tate before deploying.

Then verify the EcodiaAttribution component is imported in the layout file:
```
grep -rn "EcodiaAttribution\|ecodia-attribution" src/ | grep -E '(layout|footer|app)\.tsx'
```
Expected: at least one hit in the layout / Footer component.

## Origin

2026-04-28 12:55 AEST. Tate flagged on the chambers fork: "ecodia labs is never surfaced publicly, and we have an Ecodia Attribution element convention that should be put in the footer." Audit found four Ecodia Labs leaks in chambers (package.json description, README lines 3 and 70, Home.tsx:166 "Powered by Ecodia Labs", TenantNotFound.tsx:10 "Powered by Ecodia Labs - Chambers Platform") and zero EcodiaAttribution component installed. Two existing canonical implementations were located in EcodiaSite and coexist; the convention had been logged in code but never surfaced as durable doctrine.

Remediation in same conversation:
- Sent addendum to running chambers fork (`fork_moi08v5y_c80250`) with explicit edits + EcodiaAttribution component code to ship in the same deploy cycle as the TS fixes.
- Spawned parallel fork (`fork_moi1gi2b_ec257e`) to sweep every other Ecodia-owned workspace for the same leaks and install the attribution element where missing.
- This pattern file written so future-me grep on "ecodia labs", "attribution", "footer", "branding" surfaces the rule before any new public-facing artefact ships.

## Cross-references

- `coexist-vs-platform-ip-separation.md` (companion: which Ecodia entity owns what)
- `~/CLAUDE.md` "Output Formatting: Global Absolute Rules" rule 3 ("No watermark branding on client-facing artefacts" - the minimum branding rule. The EcodiaAttribution element IS the minimum, not a redundant watermark.)
- `brief-names-the-product-not-the-immediate-task.md` (every brief that scaffolds a public-facing product must include the attribution-install step)
- `deploy-verify-or-the-fork-didnt-finish.md` (companion deploy-discipline doctrine from same conversation)
- `project-naming-mirrors-repo-name.md` (companion deploy-discipline doctrine from same conversation)
