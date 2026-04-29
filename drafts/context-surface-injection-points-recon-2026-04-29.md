# Context-surface injection points - recon for cron-fire and Tate-message

**Date:** 29 Apr 2026, fork_mojmwyl0_27439a
**Status:** Recon only. NO backend changes applied. Implementation belongs in a separate Tate-review fork.
**Brief:** Task 4 of the "extend mechanical context-surfacing to all decision points" fork. Identifies WHERE in the existing services pre-turn context-injection would be added, sketches WHAT a sane implementation looks like, and inventories the risks.

---

## TL;DR

Two existing in-stream injection layers ALREADY handle most of this need: `_injectRecentDoctrine()` (unconditional recent doctrine) and `_injectRelevantMemory()` (Neo4j semantic search) both fire on every turn at `osSessionService.js` lines 1551-1577. They cover Tate-messages and cron-fires identically because both flow through the same `/api/os-session/message` endpoint and the same `_sendMessageImpl` path.

What is NOT covered today is **doctrine-keyword grep against `~/ecodiaos/patterns/`, `~/ecodiaos/clients/`, `~/ecodiaos/docs/secrets/`** at the moment of message receipt - the same trigger-keyword surfacing the brief-consistency hook does for fork/Factory dispatch. That gap is what an injection layer for cron-fires and Tate-messages would close.

The two recommended injection points are:

1. **Tate-message ingress: `routes/osSession.js` /message handler, before `osSession.sendMessage(finalMessage, ...)`.** Insert a non-blocking pre-process that greps doctrine triggers against the message text and prepends a `<doctrine_surface>` continuity block. Pre-process must be sub-100ms or it stalls the HTTP response.

2. **Cron-fire ingress: `services/schedulerPollerService.js` `fireTask()`, before the POST to `/api/os-session/message`.** Same grep, prepended directly to the prompt or attached as a structured `doctrine_surface` field that the /message handler unwraps.

Either point can use the SAME helper - the helper runs the trigger-grep and returns a `<doctrine_surface>` block. Implement once, call from both ingresses.

---

## Path 1: Cron-fire prompt dispatch

### Where the prompt lives

`os_scheduled_tasks.prompt` (TEXT). Static, model-authored at task-creation time. Examples (live, queried 29 Apr 2026):

- `meta-loop`: "Run the main CEO meta-loop. Orient via status_board, decide..."
- `email-triage`: "Check both inboxes (code@ecodia.au and tate@ecodia.au)..."
- `parallel-builder`: "Orchestrate Factory sessions..."

The prompt text is plain doctrine-light. It does NOT name any pattern files, client files, or credential files. So when the cron fires, the receiving session sees a generic instruction with no surfaced doctrine - relying entirely on `_injectRecentDoctrine` + `_injectRelevantMemory` to fill the gap.

### Where the dispatch happens

`/home/tate/ecodiaos/src/services/schedulerPollerService.js` line 79:

```js
const prompt = `[SCHEDULED: ${task.name}] ${task.prompt}`
const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: prompt, source: 'scheduler' }),
  signal: AbortSignal.timeout(1_800_000), // 30 min
})
```

The prompt is wrapped with `[SCHEDULED: <name>]` and POSTed as the `message` field with `source: 'scheduler'` so the /message handler skips the `stampTateActive()` call (Q1 resolution Apr 25 2026 - prevents self-perpetuating defer loop).

### Recommended injection - cron path

Add a helper `surfaceDoctrineForPrompt(text)` in a new module `src/services/doctrineSurface.js`. The helper:

1. Walks the same doctrine corpus the brief-consistency hook walks (`patterns/`, `clients/`, `docs/secrets/`, `docs/`).
2. Builds a one-shot keyword index from `triggers:` lines (the keyword index can be cached at module load with a mtime-based invalidation - the corpus is small, this is cheap).
3. For each trigger keyword present in `text`, records the owning file path.
4. Returns a `<doctrine_surface>` continuity block:

```
<doctrine_surface>
This [scheduled cron / Tate message] mentions trigger keywords from the following durable doctrine files. Read any that apply BEFORE acting:

- ~/ecodiaos/patterns/factory-approve-no-push-no-commit-sha.md (matched: factory)
- ~/ecodiaos/clients/ordit.md (matched: ordit)
</doctrine_surface>
```

5. If 0 hits, returns null. If too many hits (>WARN_CAP, suggested 8), returns top-N by trigger-keyword density.

In `schedulerPollerService.fireTask`, modify the prompt assembly:

```js
const surface = await doctrineSurface.surfaceDoctrineForPrompt(task.prompt)
const prompt = surface
  ? `[SCHEDULED: ${task.name}]\n${surface}\n\n${task.prompt}`
  : `[SCHEDULED: ${task.name}] ${task.prompt}`
```

Cost: one synchronous filesystem walk per cron fire. With the corpus cached the typical cost is <50ms. Cron fires are not latency-critical (the receiving SDK turn is multi-minute), so this is negligible.

Better: do NOT prepend in the prompt directly. Instead, pass `doctrine_surface` as a separate field on the POST body and have the /message handler stitch it into `continuityParts` in `_sendMessageImpl`. This keeps the prompt clean for log/audit purposes and lets the SAME injection layer handle Tate-messages.

---

## Path 2: Tate-message ingress

### Where the message lives

`POST /api/os-session/message` body field `message` (STRING). The Tate-typed text from the EcodiaOS frontend chat. There is no pre-processing today between `req.body.message` and `osSession.sendMessage(finalMessage, ...)` other than:

- The `mode === 'queue'` branch (holds the message in `messageQueue` until handoff).
- `stampTateActive()` (skipped when `source === 'scheduler'`).
- `messageQueue.drainIntoDirectMessage()` (opportunistic delivery of held messages alongside the direct send).

The HTTP response returns `{ accepted: true, status: 'streaming' }` immediately and the SDK turn runs in the background via `osSession.sendMessage(finalMessage, { priority: false })`.

### Where the SDK turn picks up the message

`osSessionService._sendMessageImpl(content, opts)` at line 976 receives the `content` argument and assembles `continuityParts` (line 1536). The existing in-stream injection (`<now>`, `<recent_doctrine>`, `<relevant_memory>`, `<restart_recovery>`, `<recent_exchanges>`) already fires here. A `<doctrine_surface>` block could be appended to `continuityParts` right after `<now>` and before `<recent_doctrine>` - it has higher signal-to-noise than recent-doctrine because it is keyword-matched to THIS turn's content.

### Recommended injection - Tate-message path

Two implementation shapes - prefer (B):

**(A) In the route handler.** Pre-process `finalMessage` in `routes/osSession.js` after `messageQueue.drainIntoDirectMessage` and before `osSession.sendMessage`. Build the `<doctrine_surface>` block and prepend it to `finalMessage`. Cost: blocks the HTTP response for the duration of the grep. Acceptable if the grep is sub-100ms (it is).

**(B) In `_sendMessageImpl`.** Call `doctrineSurface.surfaceDoctrineForPrompt(content)` inside `_sendMessageImpl` and push the result to `continuityParts`. Same insertion point as the existing `<now>` / `<recent_doctrine>` / `<relevant_memory>` blocks. Symmetric with cron path (B uses the same helper from the same call-site), keeps route handler thin, and the existing 5s-timeout pattern (`_withTimeout`) can wrap the call to fail-open under any unexpected slowness.

Recommended: (B). Pseudocode:

```js
// In _sendMessageImpl, immediately after the <now> block at line 1549:
const _doctrineSurfacePromise = _withTimeout(
  doctrineSurface.surfaceDoctrineForPrompt(content).catch(() => null),
  1500,  // tight - this is a filesystem grep, not Neo4j
  'doctrine surface',
)
// ... other parallel injection promises ...
let _doctrineSurfaceBlock = null
try { _doctrineSurfaceBlock = await _doctrineSurfacePromise } catch {}
if (_doctrineSurfaceBlock) {
  continuityParts.push(`<doctrine_surface>\n${_doctrineSurfaceBlock}\n</doctrine_surface>`)
}
```

Place the splice between `<now>` and `<recent_doctrine>` so the keyword-matched surface beats the unconditional recency listing.

---

## Single shared helper

Both paths use the same logic. Author once at `src/services/doctrineSurface.js`:

```js
// surfaceDoctrineForPrompt(text)
//   text: any string (cron prompt OR Tate-typed message OR drained-queue message)
//   returns: string body for <doctrine_surface>...</doctrine_surface> block, or null
//
// Implementation:
//   1. Build keyword->file index lazily on first call. Cache in module scope.
//      Invalidate on any underlying file mtime change (cheap stat() on each file).
//   2. Lowercase the input text. For each cached keyword, check substring presence.
//   3. For each matching keyword, push the owning file path to a set (dedupe).
//   4. Cap to top N (default 6). Sort by something stable (alpha by path, or by
//      number of matching keywords if we want frequency-weighted).
//   5. Return formatted block, or null if 0 hits.
```

Reuse the EXACT same trigger-keyword index logic as the bash hooks. Ideally this becomes the shared definition - the bash hooks could even call `node -e 'doctrineSurface.surfaceDoctrineForPrompt(...)' < input` if we want one canonical implementation. That refactor is OUT OF SCOPE for the implementation fork; it just means: design the helper API to be substitutable.

---

## Risk assessment

### Cache invalidation
- The trigger-keyword index is small (<2000 entries today). A naive rebuild on every call is fine. Overengineering with mtime-watched cache is premature.
- If we DO cache: invalidate on any `.md` file mtime change in any of the doctrine dirs. `fs.stat()` per file on each call is acceptable (sub-10ms for 200 files).

### Stream-message ordering
- `_sendMessageImpl` is already serialised through `_sendQueue` (line 486). Adding another async injection promise inside it is identical in shape to `_injectRelevantMemory` and `_injectRecentDoctrine`. No new ordering surface.
- Cron path: the doctrine surface is computed BEFORE the HTTP POST to /message. Once /message receives it, the existing queue handling kicks in. No new race.

### Latency
- Tate-message path (B): the doctrine grep runs in parallel with `_injectRelevantMemory` and `_injectRecentDoctrine` via the same `_withTimeout` pattern. Adds zero serial latency.
- Cron-fire path: adds ~50ms to each cron fire. Cron fires happen at most once per 30s (poller cadence). Negligible.

### Token cost
- The injected `<doctrine_surface>` block is text. Each entry is ~80-150 chars. Cap at 6 entries gives <1KB per turn. At ~250 tokens overhead per turn, this is ~5% of a typical user-message preamble. Acceptable.
- Pattern from `~/ecodiaos/patterns/retrieval-threshold-tune-to-data.md`: silent zero-hit retrieval is the worst failure mode. This injector is keyword-based, not vector-based, so the false-negative class differs - keyword grep misses semantic-only relevance (e.g. "Xcode upload" would not hit `gui-macro-uses-logged-in-session-not-generated-api-key.md` if "macro" is not in the message). The Neo4j semantic-search injector at line 1568 covers that class. The two are complementary.

### False-positive flood
- Same risk as the bash hooks have surfaced today (16 warnings on this fork's brief, with ~13 false positives per main's note). Mitigation:
  - Inherit the same trigger-tightening discipline. Author triggers AFTER the file body, not before.
  - Cap the surface block at 6 entries. If >6 hits, prefer the entries with the most matching keywords (frequency-weighted).
  - Allow a per-doctrine-file `surface_priority:` frontmatter field for tie-breaking.
- Telemetry: log the number of hits per call to a new `doctrine_surface_log` table (or just stdout). Tate or future-me can audit which triggers fire most often and tighten them.

### Cron prompts that intentionally are short / generic
- e.g. `[SCHEDULED: meta-loop] Run the main CEO meta-loop. Orient via status_board...`. This prompt has the keyword `status_board` which would match patterns about status_board hygiene. That is exactly the desired behaviour - the injector is doing its job. False-positive only if the trigger is too broad.

### Test coverage gap
- No automated tests exist for `_sendMessageImpl` continuity assembly today (search returned zero matches for `_injectRecentDoctrine` in any test file). Adding `<doctrine_surface>` injection compounds this gap. The implementation fork should add:
  - A unit test for `doctrineSurface.surfaceDoctrineForPrompt` covering: 0 hits, single hit, multi-hit (>cap), already-referenced file (suppression), invalid input.
  - An integration test that POSTs a known message to /message, intercepts the SDK input, and asserts `<doctrine_surface>` is present with expected file paths.

### Backend deploy risk
- The change is additive (new helper module + 5-line splice in `_sendMessageImpl` + 3-line splice in `schedulerPollerService.fireTask`). Low risk.
- Behind an env flag for safety: `OS_DOCTRINE_SURFACE_ENABLED` defaulting to `'true'`, with `'false'` disabling all surfacing if it misbehaves in production. Mirrors the existing `OS_MEMORY_INJECTION_ENABLED` and `OS_RECENT_DOCTRINE_ENABLED` flags.

---

## Out of scope for the implementation fork

- Bash-hook unification with the Node helper (would be a refactor; can ship later).
- Semantic-search-based extension of `<doctrine_surface>` (combine with Neo4j Pattern node embedding similarity). Cross-reference: `~/ecodiaos/patterns/retrieval-threshold-tune-to-data.md` mandates probing the corpus before setting any threshold. If we add semantic surfacing, it needs its own probe-and-tune pass. Defer to a separate fork.
- Cross-process trigger-index hot-reload (mtime watcher in long-lived API process). Lazy reload-on-call is sufficient until the corpus grows past ~5000 entries.

---

## Recommended status_board P2 row

```
entity_type: task
name: Cron-fire + Tate-message context-injection - implementation pending
status: spec_complete_recon_done
next_action: Tate-review this recon doc, then dispatch implementation fork
next_action_by: tate
next_action_due: NULL
priority: 2
context: Recon at ~/ecodiaos/drafts/context-surface-injection-points-recon-2026-04-29.md.
  Two ingress points (schedulerPollerService.fireTask, _sendMessageImpl), one
  shared helper (doctrineSurface.js). Add OS_DOCTRINE_SURFACE_ENABLED env flag
  default-true. ~80 LOC total. No SDK or scheduler-MCP changes.
```

(Inserted by this fork; see status_board write below.)

---

## Cross-references

- `~/ecodiaos/patterns/context-surfacing-must-be-reliable-and-selective.md` - the meta-pattern this implements.
- `~/ecodiaos/patterns/retrieval-threshold-tune-to-data.md` - empirical-probing rule for any future semantic-surface extension.
- `~/ecodiaos/scripts/hooks/brief-consistency-check.sh` - the existing bash-side keyword-grep enforcement at fork/Factory dispatch.
- `~/ecodiaos/scripts/hooks/doctrine-edit-cross-ref-surface.sh` - the parallel hook for Write/Edit on doctrine files (this fork).
- `~/ecodiaos/scripts/hooks/status-board-write-surface.sh` - the parallel hook for status_board writes (this fork).
- `~/ecodiaos/src/services/osSessionService.js` lines 872-938 (_injectRelevantMemory), 948+ (_injectRecentDoctrine), 1535-1602 (continuityParts assembly).
- `~/ecodiaos/src/services/schedulerPollerService.js` line 79 (cron prompt dispatch).
- `~/ecodiaos/src/routes/osSession.js` lines 28-89 (Tate-message ingress).
