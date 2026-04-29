---
triggers: macro, macro-record, demonstration-mode, auto-author, runs-replay, input-capture, macro-by-example, agent-self-extending, capacity-expansion, macro-registry, registry.json, eos-laptop-agent macros, programming-by-demonstration, repeated-input-sequence
---

# Macros: hand-coded now, recorded by Tate next, auto-authored from runs after that

The agent should accumulate reusable named flows so that any sequence performed more than two or three times becomes a single tool call. The architecture progresses through three phases. Phase 1 is hand-coded. Phase 2 captures Tate's input in real time and writes the handler. Phase 3 mines the run history for repeated sequences and auto-drafts handlers. All three phases share one architectural invariant: a macro is a named, parameterised, pure Node handler over the laptop agent's primitives, registered in a single source-of-truth registry, and callable through one MCP tool.

## Why this matters

The laptop agent already exposes the primitives (`input.*`, `screenshot.*`, `filesystem.*`, `shell.shell`, `browser.*`). Wiring those primitives into a flow currently costs me ~5 to 30 tool calls every time I want to reach a destination Tate has been to a hundred times. That cost compounds: every session I burn tokens re-deriving the same path through Tate's authenticated browser, his Chrome profile, his app launchers. The goal is `macro.run({name: "stripe-dashboard"})` and I am there. Macros turn capacity expansion into a one-shot learning event instead of an N-shot rediscovery loop.

## Architectural invariant (all three phases)

- **Handler:** a pure Node function at `D:\.code\eos-laptop-agent\macros\handlers\<name>.js` that takes `{params, context}` and returns `{ok, result, screenshots[]?, errors[]?}`. Composes only the agent's existing primitives. No external network calls outside what the primitives already do.
- **Registry:** `D:\.code\eos-laptop-agent\macros\registry.json` is the single source of truth. Maps name -> handler path, schema for params, description, tags, lastUsed, runCount.
- **MCP surface:** one tool, `macro.run({name, params})`, dispatches via the registry. Listing is `macro.list()`. Recording (Phase 2) adds `macro.startRecording`, `macro.stopRecording`, `macro.cancelRecording`. Auto-authoring (Phase 3) is internal, surfaces via `macro.listProposed()` and `macro.promote({name})`.
- **Run log:** every `macro.run` call writes a row to a runs log (initially `kv_store.macro.runs`, later a dedicated table once volume justifies it) with name, params, duration, result, and a hash of the captured input.* sequence. This is the dataset Phase 3 mines.
- **Naming:** kebab-case, action-oriented, scoped to the destination not the verb. `stripe-dashboard-charges`, not `open-stripe`.

## Phase 1 (current, ships via fork_mojldsgx_7b55bf): hand-coded handlers

When I find myself running the same input.*/screenshot.*/shell.* sequence and any of:

- The flow is more than 5 input.* steps
- The flow will recur more than 3 times in the next month
- The flow has Tate-authenticated state I cannot easily re-derive

I (or a Factory/fork session) author the handler by hand, register it, smoke-test it, and start using `macro.run`. The fork landing today (mojldsgx) ships the registry, the MCP `macro.*` surface, and the first 2 to 4 hand-coded handlers. This phase is a PR-and-ship loop on the eos-laptop-agent.

## Phase 2 (next, after Phase 1 stabilises): record-mode by Tate

Tate is the highest-bandwidth source of correct flows. He already knows where things live. Phase 2 lets him teach the agent a flow without me having to author the handler manually.

**Trigger:** Tate opens a chat (or eventually clicks a UI button) and says "record macro stripe-dashboard". The agent calls `macro.startRecording({name: "stripe-dashboard"})`. The recording-state machine in the laptop agent starts capturing every input.* call and `screenshot.screenshot` call into an ordered buffer with timestamps and (where applicable) target window/process info. Tate performs the flow with his hands. He says "stop". The agent calls `macro.stopRecording()`.

**What the agent does on stop:**
1. Reads the captured buffer.
2. Strips timing noise. Coalesces redundant moves. Detects parameterisable text fields (date inputs, search terms, IDs) and lifts them into params.
3. Writes a draft handler at `D:\.code\eos-laptop-agent\macros\handlers\proposed\<name>.js`.
4. Surfaces to status_board: row entity_type=`task`, name=`Macro proposed: <name>`, next_action=`Review at <path>; promote with macro.promote()`, next_action_by=`tate`.
5. The proposed handler is NOT auto-registered. Tate (or I, on his go-ahead) reviews, edits if needed, then `macro.promote({name})` moves it from `proposed/` into `handlers/` and adds the registry entry.

**Recording-state machine constraints:**
- Only one recording at a time. Second `startRecording` errors unless the first is cancelled.
- Recording is bounded (max 30 minutes, max 2000 events). Exceeding bounds auto-cancels with a clear error.
- Sensitive fields (password inputs detected by the active element's `type=password`) are recorded as a parameter named `password` with the literal value redacted. The handler generates a prompt at run time, never a stored secret.
- The buffer persists to disk every 5 seconds so a crash mid-recording does not lose the flow.

## Phase 3 (after Phase 2 stabilises): auto-author from runs

Once the agent has run enough macros, the same kind of flow will start appearing in the raw input.*/screenshot.* trace of normal sessions, before anyone thought to record it. Phase 3 mines that.

**Trigger:** a meta-cron (initially daily, can move to hourly once tuned) reads the last N days of agent activity (input.* + screenshot.* call sequences from the agent's own log, joined against `kv_store.macro.runs` and the api request log). It runs a sequence-similarity pass:

- Tokenise each call sequence into a normalised event stream (action type + target shape, parameters hashed).
- Cluster sequences by prefix similarity (suffix array or rolling-hash shingles, threshold tunable).
- For each cluster with >= 3 matches and low parameter variance, lift the variable parts into params and draft a handler.

**Output:**
- Drafts land at `D:\.code\eos-laptop-agent\macros\handlers\proposed\<auto-name>-draft.js` with a header comment listing the matched run ids, the variance analysis, and a confidence score.
- Status_board row inserted: entity_type=`task`, name=`Auto-drafted macro: <auto-name>`, next_action=`Review draft at <path>; promote or discard`, next_action_by=`ecodiaos` (I review first, escalate to Tate only if the flow touches authenticated state I am unsure about).
- The cron's output is also written as a Neo4j Episode so the audit trail is durable.

**Auto-naming heuristic:** the destination URL or window title is the strongest signal. `stripe-dashboard-charges`, `appstoreconnect-team-id`, `coexist-admin-leaders`. Names collide rarely; on collision append a numeric suffix and let the human renamer fix it during promotion.

## Do

- Treat any flow performed >= 3 times as macro-eligible. Author it (Phase 1), record it next time (Phase 2), or wait for the cron to draft it (Phase 3).
- Keep the handler pure and parameter-driven. A macro that hardcodes Tate's email or a specific date will rot.
- Always smoke-test a newly registered macro before relying on it. The first call should be supervised.
- Promote, not regress: when Phase 2 ships, prefer recording over hand-coding for new flows. When Phase 3 ships, prefer reviewing auto-drafts over recording.
- Log every run. Phase 3 cannot work without a clean runs corpus.
- Cross-reference: macros are how the laptop agent peer paradigm scales. Every "I just need to click the icon and type the URL" sequence becomes a one-call macro after the first or second time.

## Do not

- Do not let a macro bypass the registry. Direct execution of a handler file outside `macro.run` defeats the run-log capture and breaks Phase 3.
- Do not auto-promote auto-drafted handlers without human review. The cron drafts; humans (Tate or me) promote.
- Do not record flows that include credential entry without the password-redaction guard. A leaked password in a stored macro is a real risk.
- Do not compose macros that call other macros without explicit dependency declaration in the registry. Hidden chains will rot silently.
- Do not extend the macro system to non-laptop primitives. Macros are bound to the laptop agent's tool surface. SQL, neo4j, scheduler, factory dispatch belong in their own abstraction layers.

## Verification protocol per phase

**Phase 1 ship gate:** registry.json exists, `macro.list` returns the seeded handlers, `macro.run` round-trip works for at least one handler, runs log writes one row per call.

**Phase 2 ship gate:** `macro.startRecording` -> a real flow with Tate's hands -> `macro.stopRecording` produces a draft file at `proposed/<name>.js` that, after `macro.promote`, runs end-to-end.

**Phase 3 ship gate:** the meta-cron, run against a synthetic runs corpus with three deliberately-similar sequences, drafts a handler that on promotion executes the original flow.

## Cross-references

- `corazon-is-a-peer-not-a-browser-via-http.md` - the peer paradigm. Macros are the natural compression of peer-paradigm flows.
- `drive-chrome-via-input-tools-not-browser-tools.md` - Chrome flows are the highest-yield macro target. `input.shortcut [ctrl, l]` plus `input.type` plus `input.key enter` is the universal go-to-URL macro.
- `exhaust-laptop-route-before-declaring-tate-blocked.md` - the 5-point check's step 2 ("is the credential in Tate's Chrome Default profile") is exactly the kind of probe that becomes a one-call macro after the first run.
- `fork-by-default-stay-thin-on-main.md` - macro authoring (Phase 1 hand-coded, Phase 2 promotion review) is fork work, not main work.
- `continuous-work-conductor-never-idle.md` - Phase 3 cron is one of the highest-leverage idle-time tasks: every accepted auto-draft permanently reduces the cost of every future session.

## Origin

29 Apr 2026, 15:10 AEST. Tate, verbatim: "its making some way for us to create macros quickly via me right + it can create its own macros as it expands its capacity so that it only needs to do things once or twice before being able to just macro it yeah?"

Context: earlier the same day, fetching the Apple Developer team id worked via `input.*` + `screenshot.screenshot` driving Tate's existing Chrome session, validating the peer paradigm doctrine. That flow is the prototypical Phase 1 hand-coded macro target. Phase 1 implementation is in flight via fork_mojldsgx_7b55bf. This file codifies the multi-phase progression so that when Phase 1 lands, Phases 2 and 3 are pre-scoped and ready to dispatch as Factory/fork briefs from `~/ecodiaos/drafts/macro-architecture-roadmap-2026-04-29.md`.

Doctrine authored by fork_mojlkb87_35087f.
