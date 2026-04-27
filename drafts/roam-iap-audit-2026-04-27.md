# Roam IAP UI Audit - 2026-04-27

**Status:** Audit only. NOT dispatching Factory. status_board row `75f6855d` is parked ("Not my concern until billing funded. Park").
**Purpose:** Capture the open UI decisions while the codebase is fresh, so when Tate unparks (post-billing, pre-ASC-resubmission) the work is queued, not re-discovered.

## Files reviewed

- `src/components/paywall/PaywallModal.tsx` (484 lines)
- `src/components/paywall/WelcomeModal.tsx` (170 lines)
- `src/lib/paywall/tripGate.ts` (351 lines)

Branch: `main`, synced with `origin/main`. Commit history is unhelpful (`fjudfh` / `ddhfdh`) so the audit relies on reading current state, not diff archaeology.

## Findings

### 1. PaywallModal.tsx - inline styles throughout (484 lines)

**Observation.** Every visual rule is inline (`style={{...}}`). No Tailwind, no CSS module. Hero band, feature list, CTA button, scroll-fade, bottom-sheet animation - all inline.

**Why it is this way.** The modal renders via React portal. Inline styles guarantee the modal looks identical regardless of host page CSS. Extraction to a CSS module risks specificity bugs from the host context.

**Decision required from Tate.** Leave it. Inline-style modal portals are a defensible choice for this exact reason. The "cleanup" temptation here is cosmetic, not functional. **Recommendation: no change.** If Tate wants visual polish for ASC resubmission, that is a copy / palette pass, not a structural refactor.

### 2. WelcomeModal.tsx - `useSyncExternalStore` SSR-detection pattern (170 lines)

**Observation.** The component uses `useSyncExternalStore` to detect client-side mount. This is a Next.js / SSR-safety pattern.

**Why it is wrong here.** Roam is a **Vite + Capacitor** app. There is no SSR. The pattern is a holdover, probably copy-pasted from a Next.js example. The simpler equivalent is `const [mounted, setMounted] = useState(false); useEffect(() => setMounted(true), [])` - which is exactly what `PaywallModal.tsx` does.

**Decision required from Tate.** Replace `useSyncExternalStore` with the `useState/useEffect` pattern matching PaywallModal. **Recommendation: small Factory task when unparked. Low risk, internal consistency win, removes a confused pattern from the codebase.**

### 3. tripGate.ts - dev paywall shortcut at lines 328-333

**Observation.** `?paywall=1` and `?welcome=1` query params force the modals during dev. Gated by `import.meta.env.DEV`.

**Why it is fine.** Vite strips `import.meta.env.DEV` to `false` at production build time, so the entire `if` block is dead code in the bundle. Production-safe. **Recommendation: no change.**

### 4. Copy review - "make this one count"

**Observation.** PaywallModal CTA copy includes the line "make this one count" (last-free-trip framing).

**Decision required from Tate.** This is a voice / brand call. Pre-resubmission, Tate should read every line of customer-facing copy in the paywall flow. **Recommendation: copy pass by Tate, not a Factory task.**

### 5. lucide-react `Infinity` import

**Observation.** PaywallModal imports `Infinity` from `lucide-react` for the unlimited-trips feature row. The local name shadows the JS global `Infinity`.

**Why it does not matter.** No code in PaywallModal uses the JS global `Infinity`. The shadow is invisible. **Recommendation: no change.** Renaming to `InfinityIcon` is a cosmetic preference, not a bug fix.

## Summary - what to dispatch when unparked

When Tate unparks, the only Factory-worthy item is **#2** (WelcomeModal SSR pattern simplification). Everything else is either deliberate (#1, #3), needs Tate's voice judgement (#4), or is a non-issue (#5).

Estimated Factory session for #2: 15 minutes. One file edit, one commit. Low risk.

## Decisions still owed by Tate (when unparked)

1. ASC resubmission timing - is the IAP UI cleanup gated on the billing fix, or independent?
2. Copy pass on the paywall flow - read every CTA line.
3. Optional: green-light the WelcomeModal simplification (one-line approval).

## Next action

Hold. Status_board row `75f6855d` stays parked. This audit doc is the queue marker. Tate can read it when ASC resubmission is back on the table.
