---
triggers: claude-md, doctrine, doctrine-cadence, claude-md-reflection, paywall, tool-broken, workaround, operational-reality, environment-change, credential-rotation, mcp-schema-change, scope-decision, fresh-session, cold-start, discovery, latency, deferred-write, batch-update
---

# Discovery to doctrine in one turn — operational realities land in CLAUDE.md the turn they emerge

## The rule

When an operational reality emerges that would change how a fresh session operates, write it into the relevant CLAUDE.md the **same turn it is discovered**. Do not defer to the next `claude-md-reflection` cron.

"Operational reality" means anything in this list:

- A tool is broken or paywalled (Factory CLI, WebSearch, an MCP server)
- A workaround supersedes a previously-documented path (SDK forks instead of CLI)
- A constraint binds that future sessions will hit (long-context beta paywall on both Max accounts)
- An environment changes (NODE_ENV semantics, PM2 process renames, port changes)
- A credential rotates or a vault key changes meaning
- A scope-discipline Decision resolves a previously-open Question
- A scheduled cron is renamed, paused, or its prompt is rewritten
- An external dependency is deprecated or moved
- Auth config drifts on a client codebase in a way that affects every future audit

The relevant CLAUDE.md is one of three:
- `~/CLAUDE.md` for business / identity / commercial doctrine
- `~/ecodiaos/CLAUDE.md` for technical / operational / tooling doctrine
- `~/.claude/CLAUDE.md` for identity bootstrap (rare, requires `shell_exec` to write)

## The failure mode this fixes

`claude-md-reflection` runs nominally daily but can drift 24-48h late. Multiply that latency by N session restarts in the gap and a fresh session can hit production blockers without doctrine to guide it.

Concrete: 2026-04-28, Factory CLI paywall was live operational reality for >12 hours and survived 4+ session restarts before landing in `~/ecodiaos/CLAUDE.md`. Each fresh session in that window had to rediscover the paywall the hard way.

The cost is small per incident, large in aggregate, and the fix is a one-turn write.

## Do

- The turn you discover the operational reality is the turn you edit CLAUDE.md.
- Date the addition inline (`**2026-04-28 OPERATIONAL ALERT —** ...`). Date markers help future cleanup distinguish current alerts from durable doctrine.
- Name the workaround if any. "Tool X is broken; use Y instead" is a complete unit of doctrine. "Tool X is broken" alone forces the next session to reinvent the wheel.
- If the operational reality is generalisable (a class of failures, not a one-off), ALSO write a pattern file in `~/ecodiaos/patterns/` with `triggers:` frontmatter so it grep-surfaces.
- If discovery happens inside a cron run, edit CLAUDE.md anyway. The cron is the trigger, not the constraint.
- Mirror the key fact into a Neo4j Pattern or Decision node so semantic search hits it. Cold-start test: would a new session reading only this node make a better decision?

## Do not

- Defer the CLAUDE.md write to the next `claude-md-reflection` cycle. That cron drifts.
- Trust that "I will remember this" across session boundaries. You will not. Context resets are total.
- Bundle the operational fact into a date-titled Episode (e.g. "Meta-loop 2026-04-28") and assume future sessions will find it. They search by topic and trigger, not by date.
- Add the same fact to MEMORY.md AND CLAUDE.md - that creates drift between two sources. CLAUDE.md is authoritative for doctrine; MEMORY.md is the curated reference index.
- Wait for "enough" reality to accumulate before updating. One operational reality is enough. Batch-updating is the failure mode.

## Verification protocol

After any session where one of the trigger events occurred:

1. Did I edit the relevant CLAUDE.md THIS turn? If no, do it now.
2. Did I cite a date inline so the addition is dateable? If no, add one.
3. Did I name the workaround? If no, add it.
4. Is the operational reality generalisable? If yes, did I write a pattern file? If no, write one.
5. Did I mirror the key fact in Neo4j (Pattern or Decision)? If no, mirror it.

The five checks take under two minutes. Skipping them is what costs hours next week.

## Origin

2026-04-28 20:00 AEST. claude-md-reflection cron fired 47.5h late (last fire 2026-04-26 20:20 AEST, just under silent-loop-detector's 2.5x threshold). During the cron I added two doctrine items to `~/ecodiaos/CLAUDE.md`:

1. Factory CLI paywall operational alert — the long-context beta header is hardcoded into the CLI binary on both Claude Max accounts. SDK-based forks (`mcp__forks__spawn_fork`) bypass it. WebSearch is gated by the same paywall.
2. Self-evolution scope-discipline — Decision today resolved that self-evolution stays ecodiaos-internal; client-codebase findings surface to status_board, never unilaterally fixed.

The Factory paywall had been live for >12h before this write. That is the latency this pattern is correcting. Discovery → doctrine is a one-turn move, not a once-a-day batch.

## Related

- `~/ecodiaos/patterns/positive-synthesis-pattern-authoring.md` (cadence for lifting reflections to durable patterns)
- `~/ecodiaos/patterns/neo4j-first-context-discipline.md` (turn-open / turn-close protocol; this pattern is the turn-close mirror for doctrine writes)
- Neo4j Pattern node: "Discovery to doctrine in one turn - operational realities land in CLAUDE.md the turn they emerge" (Apr 28 2026)
- Doctrine principle: split doctrine from event (in-context, ~/ecodiaos/CLAUDE.md "Reflection structure" section)
