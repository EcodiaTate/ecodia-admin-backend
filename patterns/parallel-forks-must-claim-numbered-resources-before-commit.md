---
triggers: migration number, migration collision, parallel forks migration, 067, 068, 069, numbered resources, sequential numbering, race condition, parallel write, branch name collision, port collision, fork id collision, schema migration race, two forks same number, sequential id, ALTER TABLE collision, applyMigrations conflict
priority: high
canonical: true
---

# Parallel forks claiming numbered resources must reserve before commit, not after

## Rule

When multiple forks may write to a sequentially-numbered resource (database migrations, ports, branch names with timestamps, generated IDs, asset slot numbers), the brief MUST direct the fork to:

1. Read the current state of the numbered space at write-time, not at brief-time.
2. Pick the next free number BY OBSERVATION at the moment of write, not the number suggested in the brief.
3. If a coordinator (kv_store atomic claim, file lock, advisory lock, pg sequence) is available, USE it.

The conductor's brief naming a specific number ("use 067") is a HINT, not a reservation. Two forks dispatched 30 seconds apart with the same brief-suggested number will both write the same file and the second one will silently overwrite or both will land and the migration runner picks one nondeterministically.

## Why it matters

This bit on 29 Apr 2026 within a 4-fork dispatch window:

- Brief 1 (credit-exhaustion implementation) said: "Schema migration `067_os_forks_credit_exhaustion.sql`."
- Brief 2 (Phase D failure classifier) dispatched ~3 min later said: "Schema migration `067_outcome_event_classification.sql` (number it after the credit-exhaustion migration; if a parallel fork takes 067, bump to 068)."

The conductor caught the collision on a routine `ls migrations/` check and noticed:
- Migration 067 was actually `067_phase_e_perf_telemetry.sql` (Phase E shipped earlier, not in the conductor's recent context)
- The credit-exhaustion fork had renamed to 068 on its own
- Phase D fork was about to write 067 anyway based on its brief

Conductor sent a clarifying message to the Phase D fork redirecting to 069. Caught in time. But the brief's "if a parallel fork takes 067, bump to 068" instruction was insufficient: it only covered the case where another fork was VISIBLY writing 067. It did not cover the case where 067 was already shipped and the conductor had stale context.

Same risk applies to:
- Branch names with date-only suffixes (two forks both pick `feat/X-2026-04-29` and both `git push -u origin` → second one's push pre-collision but post-pull would either fast-forward or reject)
- Port allocations (two services both default to a port read from kv_store at boot)
- Generated IDs not seeded by an autoincrement sequence

## The right pattern

### For Postgres migrations specifically:

The brief should say something like:

> "Schema migration: pick the next free `NNN` number by listing `ls src/db/migrations/` at the moment of write. Do not trust any number suggested in this brief. Filename pattern: `<NNN>_<descriptive-snake-case>.sql`. If `<NNN>` collides with another file, increment until free."

Or even better, add a tiny helper at `~/ecodiaos/scripts/next-migration-number.sh`:

```bash
#!/usr/bin/env bash
# Returns the next free migration number, zero-padded to 3 digits.
# Atomic enough: shell ls is fine for human-pace fork dispatches (seconds apart).
# For sub-second concurrency, replace with a pg advisory lock or kv_store CAS.
cd ~/ecodiaos/src/db/migrations
last=$(ls -1 [0-9][0-9][0-9]_*.sql 2>/dev/null | sort -r | head -1 | cut -d_ -f1)
if [ -z "$last" ]; then echo "001"; exit 0; fi
printf "%03d\n" $((10#$last + 1))
```

Then briefs say:

> "Schema migration filename: `$(scripts/next-migration-number.sh)_outcome_event_classification.sql`. Run that script at write-time."

### For branch names:

Add a timestamp to seconds resolution OR include the fork ID:
- `feat/<descriptive>-<unix_seconds>` — guaranteed unique within a 1s window.
- `feat/<descriptive>-<fork_id_short>` — guaranteed unique by construction.

### For ports:

Use a dedicated kv_store key per service (`port.<service_name>`) that the service writes once on first boot via `INSERT ... ON CONFLICT DO NOTHING`. Do not pick ports from the brief.

### For generated IDs:

Use `BIGSERIAL` / `pg.uuid_generate_v4()`. Do not generate from JS at write-time without a check.

## Do

- For ANY numbered/named-uniquely resource that multiple forks could write to, the brief specifies the discovery mechanism, not the value.
- If you suggest a value in the brief (acceptable for ergonomics), explicitly tell the fork to verify-by-observation at write-time and bump if collided.
- For database migrations, use the `scripts/next-migration-number.sh` helper (or write it if it doesn't exist) so the discovery is one shell call.
- Catch collisions at brief-render time when possible: the conductor doing `ls src/db/migrations/` once before dispatching N forks and naming the next 3 free numbers explicitly is cheap insurance.

## Do not

- Do NOT instruct a fork to "use migration 067" without saying "verify 067 is free first; bump if not."
- Do NOT trust your own context for what the latest migration number is when you've been dispatching parallel work for >5 minutes.
- Do NOT rely on the migration runner to refuse to apply duplicates. Most runners apply alphabetically and will silently apply both files (with the second's ALTER TABLE either succeeding via IF NOT EXISTS or failing).
- Do NOT pick branch names that are date-only (`feat/X-YYYY-MM-DD`) when dispatching multiple forks on the same day. Add seconds or fork-id.

## Conductor pre-flight

When dispatching N parallel forks that each will write a numbered resource of the same type, the conductor SHOULD:

1. List the current numbered space ONCE (e.g. `ls src/db/migrations/`).
2. Reserve the next N numbers by naming them explicitly per fork (fork 1 gets 069, fork 2 gets 070, etc).
3. Pass the reserved number into each fork's brief as a hard parameter.

This converts "trust the convention" into "explicit assignment" and eliminates the race entirely for the human-pace dispatch case.

## Cross-references

- `~/ecodiaos/patterns/no-symbolic-logging-act-or-schedule.md` - "I'll handle the collision later" without an actual mechanism is symbolic. The reservation IS the mechanism.
- `~/ecodiaos/patterns/serialise-factory-dispatches-on-shared-codebase.md` - the broader family: parallel writers to a shared resource need explicit serialisation or atomic claim.
- `~/ecodiaos/patterns/scheduled-redispatch-verify-not-shipped.md` - same family: never assume your suggested artefact name is free, verify.
- `~/ecodiaos/patterns/check-pre-kill-commits-before-redispatch.md` - same family: re-dispatch must check what shipped before naming output paths.
- `~/ecodiaos/patterns/recurring-drift-extends-existing-enforcement-layer.md` - if migration collisions become a recurring drift mode, ship the `next-migration-number.sh` helper into a hook rather than relying on briefs to mention it.

## Origin

29 Apr 2026, ~17:50 AEST. Conductor dispatched fork_mojqy3uz (credit-exhaustion implementation, brief said migration 067) and fork_mojr9h2u (Phase D failure classifier, brief said migration 067 with weak fallback hint) within a 3-minute window. While the Phase D fork was at ~30 seconds in, the conductor ran a routine `ls migrations/` and noticed:

1. Migration 067 was already `067_phase_e_perf_telemetry.sql` (Phase E shipped earlier today, not in the conductor's brief-render context)
2. fork_mojqy3uz had self-corrected to 068
3. Phase D fork was 30s into its work and might write to 067 anyway

Conductor sent `mcp__forks__send_message` to fork_mojr9h2u redirecting to 069. Caught in time, no actual collision shipped. The doctrine codifies the rule so future dispatches don't rely on real-time collision detection by the conductor.
