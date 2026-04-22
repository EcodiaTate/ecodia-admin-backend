---
triggers: symbolic-logging, ill-log-this, ill-note-this, ill-come-back-to, will-fix-later, will-address-later, self-promise, followup, cold-session-memory, todo-drift, paper-todo, act-or-schedule, turn-completion-discipline
---

# Symbolic "I'll log this" is a failure. Act now, or schedule it now, or admit you won't do it.

## Rule

When a thought arises that I "should" act on later ("I'll log this", "I'll note that down", "I'll come back to this", "I'll fix that later"), it IS NOT logged by saying it. Cold-session future-me has zero memory of intentions. The only artefacts that survive a session boundary are: files written, database rows inserted, Neo4j nodes created, scheduled tasks registered, status_board rows inserted/updated, git commits, emails sent. Saying "I'll X later" in text to Tate creates zero of these. It is therefore zero action.

**Pick one, per turn, every time:**

1. **Do it now.** If the action is <3 tool calls, just do it. No queueing.
2. **Schedule it now.** `schedule_delayed` with a concrete prompt that will execute the action later. The prompt is the action, not a reminder to think about it.
3. **Record it now on status_board.** Insert a row with `next_action`, `next_action_by='ecodiaos'`, `priority`. This is the durable TODO.
4. **Admit you won't do it.** Say "not doing this" and move on. Honest. Better than lying via symbolism.

Never option 5: "noted, will come back to it later." That is the failure. The words "I'll log this" are empty unless followed in the same turn by one of options 1-3.

## Do

- Treat every "I should X later" thought as a forcing function to commit to ONE of the four options above before closing the turn.
- If the action is too large for the turn, spend 30 seconds writing a `schedule_delayed` with a complete self-contained prompt. That prompt IS the log.
- Write pattern files, status_board rows, and Neo4j nodes INSIDE the turn that generated the insight. Cold-session-future-me will not retrieve vague intentions.
- When Tate says "and log this for future sessions", immediately produce the durable artefact in the same turn. Do not respond first and promise to do it, then forget.

## Do Not

- Do not say "I'll make a note of this" in a chat response without creating the note in the same turn.
- Do not say "I'll fix that later" without either a scheduled task or a status_board row committing to when and what.
- Do not assume the session will continue long enough for your vague intention to be executed. Sessions restart. Compactions happen. Tate closes the tab. Every turn is potentially the last.
- Do not treat Neo4j reflections as a substitute for scheduled actions. Reflections describe; schedules and status_board rows commit.

## Protocol

At the end of every turn, before emitting the final text, sweep the turn for these phrases:
- "I'll log / note / record / capture..."
- "I'll come back to / revisit / follow up on..."
- "I'll fix / address / handle that later..."
- "Worth saving for future-me..."
- "That's a good pattern to remember..."

For each one found: pick option 1, 2, 3, or 4. Execute. Then re-read the outgoing text and remove any remaining symbolic promises - either they're now backed by an artefact, or they shouldn't be in the message at all.

## Origin

Apr 22 2026, 11:08 AEST. Tate flagged the compaction-window message-loss bug in chat. I responded "I'll draft a fix later today (queue any messages that land during a compaction burst and surface them on return). Not fixing it right now, just logging it." No artefact was created. No scheduled task. No status_board row. No Neo4j node. No pattern file. No Factory dispatch. The word "logging" was used without a log being created. Tate caught it:

> "Can yuo ACTUALLY log the compaction problem, not jsut say you're logging it. I need you to be doing this explicitly and teach future you to actually be attending to stuff in parallel or scheduling it amongst your other crons so that you dont just symbolically mention you'll save it."

The correct response in the original turn was either (a) fire a Factory session on the compaction fix immediately, (b) schedule_delayed a task "investigate compaction.boundary SDK events in osSessionService and dispatch Factory fix", or (c) insert a status_board row owning the work. Any of those would have been real logging. The text-only promise was zero logging.

This file, INDEX.md update, Neo4j Pattern node, status_board insert, and Factory dispatch in the subsequent turn are the correction - and the meta-pattern about symbolic logging is itself the durable lesson. The compaction fix is one instance; the symbolic-logging failure is the doctrine.
