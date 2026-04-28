# Per-Turn Continuity Injection Audit (fork_mohxha42_63ea9a)

Date: 2026-04-28
Author: fork_mohxha42_63ea9a (self-evolution rotation A)
Scope: every string appended to the user-message prefix in `_sendMessageImpl` of `src/services/osSessionService.js` per turn.

## 1. Injection Inventory

All injection happens inside `_sendMessageImpl` -> "Stitch continuity blocks into the USER message" (osSessionService.js:1518-1634). Blocks are tagged XML-style and concatenated with `\n\n` then prepended to `promptWithMemory`.

| # | Block | Source | When | Typical (chars) | Worst | Load-bearing |
|---|-------|--------|------|-----------------|-------|---------------|
| 1 | `<now>` | inline (1526-1536) | EVERY turn | ~40 | ~40 | YES (Apr 21 commit 7d80225) |
| 2 | `<forks_rollup>` | forkService.forksRollup (697) | EVERY turn (null when no live + no recent-done) | 0 | ~1200 | NO |
| 3 | `<recent_doctrine>` | _injectRecentDoctrine (948-974) -> getRecentHighPriorityNodes | EVERY turn (Neo4j up) | ~1500 | ~1700 | NO |
| 4 | `<relevant_memory>` | _injectRelevantMemory (872-938) -> fusedSearch (default) | EVERY turn (Neo4j up, hits >0) | ~2000 | ~7000 (neighborhood mode) | NO |
| 5 | `<restart_recovery>` | sessionHandoff.consumeHandoffState | ONLY post-drop, <6h, unconsumed | 0 (typical) | ~3000 | YES (Apr 11-12 fix) - DO NOT TOUCH |
| 6 | `<recent_exchanges>` | inline (1140-1180) | ONLY when !ccSessionId && session.id | 0 (typical) | ~12000 | YES - DO NOT TOUCH |
| 7 | `<last_turn_breadcrumb>` | inline (1092-1121) | ONLY when no recent_exchanges AND no ccSessionId | 0 | ~1300 | YES - DO NOT TOUCH |

### Out of scope
~/CLAUDE.md, ~/ecodiaos/CLAUDE.md, harness safety reminders, deferred tool listings - all loaded by the Claude Agent SDK system prompt path. Tool result blocks - injected by harness. The 70-80k tokens/turn estimate from the brief includes those sources; what we CAN reduce here is much smaller in absolute terms.

## 2. Hot Path Estimate (resumed turn, ~95% of turns)

State: `ccSessionId` present, no fresh handoff, Neo4j healthy, no live forks. Default env: `OS_MEMORY_FUSED_ENABLED` unset means `useFused = true`. fusedSearch returns NO neighbours (only semanticSearchWithNeighborhood does), so currently `<relevant_memory>` is 5 plain hits with no neighbour subtree.

| Block | Chars | Tokens |
|-------|-------|--------|
| now | 40 | 10 |
| forks_rollup | 0 | 0 |
| recent_doctrine | 1500 | 375 |
| relevant_memory (fused) | 2000 | 500 |
| TOTAL | ~3540 | ~885 |

Worst-case (forks present + Neo4j heavy + fused=false): ~10000 chars / ~2500 tokens.

## 3. Cold Path (post-restart, fresh session)

State: !ccSessionId, session.id exists, recovery unconsumed.

Adds: restart_recovery ~2000, recent_exchanges ~10000 (12k cap). Total cold-path: ~17000 chars / ~4250 tokens.

## 4. Reduction Targets

### A - relevant_memory: trim count, cap description, cap neighbours
Current: fused limit:5, desc cap 300, neighborhood-mode passes no maxNeighboursPerHit (defaults to 5 on each hit, each neighbour desc 120 chars).
Proposed: fused limit:3, desc rendered through .slice(0,200) in the formatter, neighborhood-mode passes maxNeighboursPerHit:2.
Hot-path savings: ~900 chars. Worst-case savings: ~4500 chars.

### B - recent_doctrine: trim list to 3, cap desc to 200
Current: limit:5, .slice(0,280).
Proposed: limit:3, .slice(0,200).
Savings: ~750 chars.

### C - dedup overlap doctrine vs memory
Same Neo4j node can appear in both blocks when a recent high-priority Decision is also a strong vector match on the current turn. Drop the duplicate from `<relevant_memory>` (doctrine already shows it).
Implementation: parse heads of doctrineBlock to a Set of `${label}|${name}` keys, filter+renumber memoryBlock lines, set memoryBlock=null if all removed.
Savings: ~200-1500 chars when overlap occurs.

### D - forks_rollup: tighten per-line shape
Current: brief.slice(0,80), position.slice(0,160), result.slice(0,120) fallback.
Proposed: brief.slice(0,60), position.slice(0,100), drop result fallback (next_step OR head only).
Savings: ~400-600 chars when forks active.

## 5. Proposed Hot-Path Outcome

| Block | Before | After | Delta |
|-------|--------|-------|-------|
| now | 40 | 40 | 0 |
| recent_doctrine | 1500 | 750 | -750 |
| relevant_memory | 2000 | 1100 | -900 |
| dedup | n/a | shared | -200 (avg) |
| TOTAL | ~3540 | ~1690 | -1850 (-52%) |

In tokens: ~885 -> ~420 per turn.

## 6. Don't Touch

- `<now>` block construction (1526-1536).
- sessionHandoff.js entirely.
- `<recent_exchanges>` block (1140-1180).
- `<last_turn_breadcrumb>` block (1092-1121).
- `_withTimeout` durations (5s memory/doctrine, 2s forks - Apr 23 Aura fix).
- env config, DB schema.
- Pattern surfacing (separate path).

## 7. Acceptance

1. `node -c src/services/osSessionService.js` and `node -c src/services/forkService.js` parse clean.
2. Diff modifies ONLY src/services/osSessionService.js and src/services/forkService.js.
3. `grep -n "<now>" src/services/osSessionService.js` shows the inline construction unchanged.
4. `grep -n "consumeHandoffState" src/services/osSessionService.js` shows that line unchanged.
5. `grep -n "RECENT_CHARS_BUDGET" src/services/osSessionService.js` shows the 12000 budget unchanged.

## 8. Rollback

In-process JS, no DB, no env. Rollback: `git revert <factory-commit-sha> && pm2 restart ecodia-api`. Conservative fallback: set `OS_MEMORY_INJECTION_ENABLED=false` (osSessionService.js:873) or `OS_RECENT_DOCTRINE_ENABLED=false` (osSessionService.js:949).
