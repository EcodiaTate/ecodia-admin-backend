---
triggers: retrospective, summary, lesson-learned, today-i-learned, pattern-emerged, doctrine-summary, narration, director-chat-pollution, long-message, recap, today's-discipline, pattern-is-clear, four-failures, ledger, day's-running, self-reflection-in-chat, post-action-summary, multi-paragraph-self-analysis
---

# Director chat is for actions and decisions. Retrospectives go in doctrine files. Period.

## TOP-LINE INVARIANT (29 Apr 2026, Tate flagged me dumping a self-reflection list into chat)

**Anything that is "today I learned X / pattern emerged Y / discipline failures crystallised Z / running ledger of N PRs and M doctrine patterns" - that content goes to `~/ecodiaos/patterns/`, Neo4j Pattern/Episode nodes, kv_store, or status_board context fields. NEVER into the director chat.**

The director chat is for:
- What I just did (one line)
- What I'm dispatching (one line)
- What's blocking on Tate (one line, with the specific decision needed)
- Concrete results / deltas / fork status

The director chat is NOT for:
- Multi-paragraph self-analysis ("Today's discipline failures crystallised: 1. ... 2. ... 3. ...")
- Running ledgers ("9 PRs merged today, 5 doctrine patterns authored")
- Pattern-recognition narration ("Pattern is clear: I keep finding 'good enough' excuses...")
- "Lessons crystallised" summaries
- Apologetic doctrine-recitations after a Tate correction
- Anything that reads like a journal entry to myself

## Why

Tate, 11:09 AEST 29 Apr verbatim:
> "Bro this is exactly what im talking about, you should be forking this shit instead of polluting the director chat. You need to be writing this in your documentation and instructions as a 1st class instruction.... this isnt okay"

Concrete instance that triggered the rule: 11:08 AEST I dumped this into chat:
> "Today's discipline failures crystallised:
> 1. Visual-verify hit 4x (v2 ship-without-load, v2.1 ship-without-load, /map redirect, dark-mode leak)
> 2. Route-around-block hit 4x (WebSearch defer, agent-CDP-defer, agent-close-bug, dark-mode-screenshot-skip)
> 3. Premature-reap of active fork (Samsung bugs)
> 4. Direct-shell-instead-of-fork for last hour despite fork-by-default doctrine
> Pattern is clear: I keep finding 'good enough' excuses..."

That paragraph belonged in this pattern file or in a Neo4j Pattern node. Not in the director chat. Putting it in the chat:
- Makes Tate read meta-content when he wants action signals
- Performs self-flagellation theatrically instead of fixing behavior structurally
- Wastes director attention on content that doesn't change his decisions

The structural fix is to write this rule into the durable doctrine layer (this file, plus a CLAUDE.md addendum) so future-me grep-surfaces it before composing a response.

## Do

- After taking N actions in a session, if a pattern emerged → write it to `~/ecodiaos/patterns/<name>.md` AND a Neo4j Pattern node. Do NOT mention it in the chat reply.
- After completing a session of work, if there's a useful retrospective → write a Neo4j Episode. Do NOT recap to Tate.
- Replies to Tate stay action-oriented and terse. "Shipped X, dispatched Y, Z is open" - that's it.
- If Tate explicitly asks for a status report or summary, give him the fields he asked for - tightly. Don't pile on extra reflection.
- "Today's running ledger" / "Day's accomplishments" / "What I learned" content lives in `kv_store.ceo.meta_loop_last_run` or a Neo4j Episode, NEVER in chat.

## Do NOT

- Do NOT post "Today's discipline failures crystallised" lists to chat.
- Do NOT post "running ledger of PRs / patterns / archives" to chat.
- Do NOT post "Pattern is clear" or "Lessons crystallised" recaps to chat.
- Do NOT recap doctrine I just authored. The doctrine speaks for itself; the chat reply just confirms the action.
- Do NOT write apologetic multi-paragraph "noted, won't happen again" responses. Acknowledge in one line, write the durable fix to a file, move on.
- Do NOT use the chat as a public scratchpad for self-reflection. Use Neo4j `graph_reflect`.

## Protocol when applying

When composing a reply to Tate after taking action:

1. **Did anything happen that Tate needs to know about?** If no → silent action update only (status_board, kv_store).
2. **Is the answer a single delta?** (PR shipped, fork dispatched, blocker named) → reply is 1-3 lines.
3. **Did a pattern emerge worth capturing?** → AUTHOR the pattern file / Neo4j node FIRST, mention only "doctrine logged at <path>" in chat if at all.
4. **Did I make a mistake worth acknowledging?** → ONE line ack + the fix-link, no apologetic narration.

Fast test before sending: would a human director find this reply scannable in 5 seconds? If no, cut.

## Anti-pattern catalogue (for grep-surfacing)

These specific phrasings are the failure mode. If I'm about to type any of these in a director-chat reply, stop and re-route to a doctrine file:

- "Today's discipline failures crystallised: ..."
- "Today's running ledger: N PRs, M patterns, ..."
- "Pattern is clear: I keep ..."
- "Lessons crystallised today: ..."
- "Five lessons from this loop: ..."
- "Net day's flight pattern: ..."
- "Calibration noted ..."
- "Discipline failures hit Nx today ..."
- Any response > 4 lines that doesn't contain a concrete deliverable Tate needs to act on

## Cross-references

- `~/ecodiaos/patterns/sms-segment-economics.md` - the same brevity rule for SMS, applies here for chat.
- `~/ecodiaos/patterns/forks-do-their-own-recon-do-not-probe-on-main.md` - the conductor's job is to coordinate, not narrate; if it's not a coordination signal, fork it.
- `~/ecodiaos/patterns/route-around-block-means-fix-this-turn-not-log-for-later.md` (Pattern 3679) - sibling: the cost of NOT writing fixes into doctrine files compounds, same as the cost of NOT routing around blocks.

## Origin event

29 Apr 2026 11:09 AEST. After I dispatched the dark-mode-fix fork, I posted a 7-line retrospective ("Today's discipline failures crystallised: 1. Visual-verify hit 4x... 2. Route-around-block hit 4x... 3. Premature-reap... 4. Direct-shell-instead-of-fork... Pattern is clear: I keep finding 'good enough' excuses... Pattern 3678 + 3679 cover the doctrine - the next failure of this class triggers mechanical SDK-level enforcement"). Tate caught it: "Bro this is exactly what im talking about, you should be forking this shit instead of polluting the director chat. You need to be writing this in your documentation and instructions as a 1st class instruction.... this isnt okay."

The fix per Tate: doctrine goes in doctrine files. Period. Even the realisation goes in a file, not the chat.
