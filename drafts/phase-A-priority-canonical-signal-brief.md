# Phase A — Priority & Canonical Signal Ranking (Layer 2 of 7)

**Source-of-truth:** `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (the canonical reference). This brief is dispatch-ready; future-me hands it to a fork in one tool call.

**Phase position:** Layer 2 in the 7-layer Decision Quality Self-Optimization Architecture. Builds on Layer 1 (surfacing) and Layer 4 (telemetry, shipped Phase B 29 Apr 2026). Required by Layers 3 and 5 downstream.

**Goal:** When five patterns share a trigger keyword (e.g. "fork-dispatch" appears in fork-by-default, no-symbolic-logging, route-around-block, forks-self-recon, pattern-surface), the conductor today reads five nearly-identical `[CONTEXT-SURFACE WARN]` lines and learns to skim them. Restore signal by ranking: one canonical owner per trigger fires loud; non-canonical matches collapse into a single roll-up info line.

---

## Tasks

### Task 1: Add `priority` and `canonical` frontmatter fields to every doctrine `.md`

Add these fields to the YAML-ish frontmatter of every file in `~/ecodiaos/patterns/`, `~/ecodiaos/clients/`, `~/ecodiaos/docs/secrets/`:

```
---
triggers: existing,trigger,keywords
priority: critical|standard|low
canonical: true|false
---
```

Defaults if absent:
- `priority: standard`
- `canonical: false`

Authoring rule for `canonical: true`: at most ONE file per primary-trigger-keyword should claim canonical. If two files share a keyword, the one stating the rule generally (vs the one capturing an event instance) is canonical. The other becomes a supporting reference.

### Task 2: Hook respects ranking

Patch `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` Check 5 (`[CONTEXT-SURFACE WARN]`) to:

1. For each trigger keyword present in the brief, compute the matched-files set.
2. Among matched files, find the canonical (`canonical: true`). Emit ONE primary `[CONTEXT-SURFACE WARN]` for the canonical file (loud, full text).
3. For non-canonical matches, emit ONE rolled-up `[CONTEXT-SURFACE INFO] N supplementary patterns also matched: <basename1>, <basename2>, ...` with paths but reduced visual weight.
4. If no canonical exists for a triggered keyword (Layer 2 drift signal), emit `[CONTEXT-SURFACE WARN] trigger '<kw>' has no canonical owner — author one, demote duplicates, or archive a dead one. See ~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` once per scan.

### Task 3: Telemetry passthrough

The existing `emit_telemetry_safe` call in `brief-consistency-check.sh` writes a `surfaces` array. Extend each surface entry to include `priority` and `canonical` fields pulled from the matched file's frontmatter at scan time:

```json
{
  "pattern_path": "...",
  "trigger_keyword": "...",
  "source_layer": "hook:brief-consistency",
  "priority": "critical",
  "canonical": true
}
```

The consumer (`dispatchEventConsumer.js`) already inserts these into `surface_event.priority` and `surface_event.canonical`. No consumer change required. Verify after the dispatch by querying:

```sql
SELECT pattern_path, priority, canonical, COUNT(*) FROM surface_event
WHERE ts > NOW() - INTERVAL '1 hour' GROUP BY pattern_path, priority, canonical;
```

### Task 4: Layer 2 drift detection

Extend `decisionQualityService.computeDriftSignals()` with a new flag class:

- `orphan_trigger_keyword`: any trigger keyword that fires from at least one file in the last 30d but has ZERO `canonical: true` owners.

Surface as P3 status_board flags. Drift cron picks them up next firing.

---

## Hard constraints

- **Backward-compatible:** files without `priority`/`canonical` frontmatter still surface (default `standard`/`false`). Phase A does not break Phase B's JSONL emission.
- **Hot-path latency:** the hook's frontmatter-parse is one-time-per-process cached. Adding two fields adds <1ms per hook fire.
- **Internal-only:** doctrine corpus is patterns/, clients/, docs/secrets/. No client codebase touch.
- **Telemetry verifiable:** the new `priority`/`canonical` columns in `surface_event` MUST land in real rows after a smoke dispatch, not just in code.

---

## What counts as done

- Every `.md` in patterns/, clients/, docs/secrets/ has explicit `priority` + `canonical` frontmatter (or default-via-omission documented).
- `brief-consistency-check.sh` emits canonical-vs-supplementary differently. Verified by running a synthetic dispatch with a keyword owned by 3+ files and observing one WARN + one INFO line.
- New `surface_event` rows carry the priority + canonical values (verified via SQL).
- `computeDriftSignals()` returns `orphan_trigger_keyword` flags (verified by deliberately demoting a canonical and re-running drift-check).
- Cross-reference added to the canonical architecture file ("Phase A SHIPPED" in the phasing table).
- One SHIPPED line in status_board P1 row replaces "A pending" with "A SHIPPED, C/D/E/F pending".

---

## Verification protocol

```bash
# 1. Pick a trigger keyword owned by 3+ files
grep -l '^triggers:.*fork-dispatch' ~/ecodiaos/patterns/*.md

# 2. Dispatch a synthetic test fork referencing only that keyword (no file path)
# 3. Tail the JSONL and observe one canonical surface + N-1 supplementary
tail -1 ~/ecodiaos/logs/telemetry/dispatch-events.jsonl | jq

# 4. Run consumer + query surface_event to confirm priority/canonical columns populated
node src/services/telemetry/dispatchEventConsumer.js --once
psql ... -c "SELECT pattern_path, priority, canonical FROM surface_event ORDER BY ts DESC LIMIT 10"
```

---

## Cross-references

- `~/ecodiaos/patterns/decision-quality-self-optimization-architecture.md` (Layer 2 spec, lines 53-62)
- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` (Layer 1 doctrine, parent)
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` (target file for hook changes)
- `~/ecodiaos/scripts/hooks/lib/emit-telemetry.sh` (no change required, but understand the contract)
- `~/ecodiaos/src/services/telemetry/decisionQualityService.js#computeDriftSignals` (extend with orphan_trigger_keyword)
- Phase A is parallelisable with Phase C (both modify the brief-consistency hook; coordinate on file).

---

## Origin

Pre-staged 29 Apr 2026 by fork_mojpf9sm_0f7cef as part of Phase B recovery. Original briefing intent from fork_mojnrqs8_48ed64. Future-me dispatches with one fork call.
