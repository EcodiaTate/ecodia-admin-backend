# Macro Architecture Roadmap

**Date:** 29 Apr 2026
**Author:** EcodiaOS (fork_mojlkb87_35087f)
**Companion doctrine:** `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
**Companion Neo4j node:** Strategic_Direction "Macro architecture: Phase 1 hand-coded, Phase 2 record-mode, Phase 3 auto-author from runs"

## Summary

Three-phase plan to make the laptop agent self-extending. Phase 1 hand-coded macros land today via fork_mojldsgx_7b55bf. Phases 2 and 3 are pre-scoped here so they can be dispatched as Factory/fork briefs immediately after Phase 1 stabilises (target: 48 hours of clean runs after merge).

## Sequencing

| Phase | What ships | Owner of authoring | Dispatch readiness |
|---|---|---|---|
| 1 - hand-coded | registry.json, `macro.run`, `macro.list`, 2-4 seeded handlers | Me + Factory forks | In flight (fork_mojldsgx_7b55bf) |
| 2 - record-mode | `macro.startRecording`, `macro.stopRecording`, recording state machine, parameter inference, draft writer, `macro.promote` | Tate's hands + agent | Brief A below, dispatch on Phase 1 stabilisation |
| 3 - auto-author | Meta-cron sequence-mining, similarity clusterer, draft writer, status_board surfacing | Cron + agent | Brief B below, dispatch ~7 days after Phase 2 ships once runs log has volume |

## Fork Brief A: Phase 2 record-mode by demonstration

**Goal:** Tate can teach the laptop agent a flow with his hands and have it written as a reusable macro.

**Repo:** `eos-laptop-agent` on Corazon (`D:\.code\eos-laptop-agent`). PR target: `main`. Branch: `feat/macro-record-mode`.

**Files to add or modify:**

- `src/modules/macro/recorder.js` - new. Recording state machine. Singleton. Holds the active recording (name, started_at, events[], paused_at?). Writes to disk every 5s at `D:\.code\eos-laptop-agent\.state\recordings\<name>.jsonl`.
- `src/modules/macro/eventCapture.js` - new. Wraps every `input.*` and `screenshot.*` primitive so when a recording is active, the call is mirrored into the recorder buffer. Wrap at the module-export boundary, not inside each handler, so future primitives are auto-captured.
- `src/modules/macro/draftWriter.js` - new. Reads a finished recording buffer, normalises events, infers parameters (heuristic: any `input.type` value that looks like a URL, email, ID, or date is a candidate param; same value appearing once is a param, same value appearing twice is a constant), emits a Node handler file.
- `src/modules/macro/index.js` - extend. Add `startRecording`, `stopRecording`, `cancelRecording`, `promote` MCP tool surface.
- `src/modules/macro/handlers/proposed/.gitkeep` - new directory.
- `tests/macro-recorder.test.js` - new. Synthetic event stream -> draftWriter -> handler runs end to end.
- `README.md` - extend with Phase 2 doc.

**Constraints:**

- Password redaction: any input field where the focused element's `type` is `password` (probe via `browser.evaluate` or window-level keyboard API) records the value as `__PASSWORD__` placeholder; the generated handler accepts `params.password` and prompts at run time.
- Recording bounds: 30 min wall clock, 2000 events. Exceeding either auto-cancels with a status_board notification.
- Only one active recording at a time. `startRecording` while one is active returns an error.
- Promotion is a separate explicit step. Recording NEVER auto-registers. Always lands in `handlers/proposed/`.
- The recorder must NOT capture filesystem.* or shell.* calls in v1. Phase 2 scope is GUI-flow capture only. Wider primitives are a Phase 2.5 expansion.

**Test plan:**

1. Synthetic test: feed a known event stream into the recorder, stop, confirm draftWriter produces a syntactically valid handler that re-executes the same primitives in order.
2. Live test on Corazon: Tate records "open Stripe dashboard, click Payments, take screenshot". Stop. Inspect proposed handler. Promote. Run via `macro.run`. Visual screenshot match.
3. Bound test: simulate 2001 events, confirm auto-cancel + status_board row.
4. Password test: record a flow including a password field, confirm the value is `__PASSWORD__` in the proposed handler and that promotion + run prompts for it.
5. Crash test: kill the agent mid-recording, restart, confirm partial buffer is recoverable from `.state/recordings/`.

**Deliverable:** a merged PR on eos-laptop-agent main, the agent restarted via PM2, `macro.list` showing existing Phase 1 handlers plus the new tool surface, one Tate-recorded handler promoted and used in a real session.

**Estimated effort:** 1 fork session, 2-3 hours of agent work, plus a 10-minute Tate test session for the live record/promote round trip.

## Fork Brief B: Phase 3 auto-author meta-cron

**Goal:** Without human prompting, the agent identifies repeated input.* sequences in its own activity log and drafts macros for review.

**Repo:** ecodiaos-backend (the cron lives here, not on the laptop agent). PR target: `main`. Branch: `feat/macro-auto-author-cron`.

**Files to add:**

- `src/services/macroAutoAuthor.js` - new. The mining and drafting service.
- `src/routes/cron/macroAutoAuthor.js` - new. Cron handler.
- `src/services/sequenceSimilarity.js` - new. The diff/cluster algorithm (see below).
- A scheduled cron entry: initially daily 03:00 AEST, can move to hourly once tuned.
- A laptop-agent-side endpoint to write proposed handlers: `POST /api/macro/proposeDraft` with auth, body `{name, handlerSource, originRunIds[], confidence, varianceAnalysis}`. Writes to `handlers/proposed/<name>-draft.js` with the documented header comment.

**Algorithm sketch (sequenceSimilarity.js):**

1. **Source data:** join three streams over the last 14 days:
   - `kv_store.macro.runs` (rows from existing macro.run calls, post-Phase 1)
   - laptop-agent request log (every input.*/screenshot.*/shell.* call with timestamp, params, source session)
   - os request log (every MCP tool call from the OS, scoped to laptop-agent calls)
2. **Tokenise** each call sequence into a normalised event stream. Each event becomes a token: `<verb>:<target_shape>` where target_shape is the param structure with values hashed (e.g. `input.type:{selector_hash, text_hash}`).
3. **Cluster by prefix:** rolling-hash shingles of length 3 to 8. Sequences sharing >= 60% of their shingles cluster together.
4. **Variance analysis:** for each cluster with >= 3 members, examine the variable token positions. Positions that vary across runs are param candidates; positions that are constant are baked in. Confidence = (members * (1 - position_variance_ratio)).
5. **Draft:** for clusters with confidence >= 0.6, generate a handler. Header comment includes: matched run ids, variance map, confidence score.
6. **Surface:** POST to laptop agent's proposeDraft endpoint. Insert a status_board row entity_type=`task`, name=`Auto-drafted macro: <name>`, next_action=`Review draft at proposed/<name>-draft.js`, next_action_by=`ecodiaos`. Write a Neo4j Episode with the cluster details for audit.

**Output format (proposed handler header):**

```js
// AUTO-DRAFTED MACRO: <name>
// Generated: <ISO timestamp>
// Confidence: 0.78
// Source runs: [run_id_1, run_id_2, run_id_3]
// Variance map:
//   pos[3].text -> param "search_term" (3 distinct values)
//   pos[7].selector -> constant (3/3 matches)
// Reviewer notes:
//   - Verify the URL in step 2 matches your intent
//   - Test once before promoting
```

**Cadence:**
- Initially: daily 03:00 AEST.
- After 30 days of clean operation: move to every 6h.
- After 60 days and >= 10 successful promotions: move to hourly with a 15-min cooldown per cluster.

**Test plan:**
1. Synthetic corpus: hand-craft 3 deliberately-similar sequences in the runs log, run the cron, confirm a draft lands at `proposed/`.
2. Negative test: 3 deliberately-DISSIMILAR sequences, confirm no draft.
3. Confidence test: 3 sequences with high variance in 4 of 5 positions, confirm low confidence (<0.6) and no draft.
4. Round trip: a synthetic auto-draft is promoted, runs against the live agent, success.
5. Status_board test: confirm row inserted with correct fields and Episode written.

**Deliverable:** merged PR on ecodiaos-backend main, cron registered in `os_scheduled_tasks`, laptop-agent endpoint live, one synthetic round-trip end-to-end test passing in CI.

**Estimated effort:** 1 fork session for the laptop-agent endpoint, 1 fork session for the backend cron + similarity algorithm. ~4-5 hours of agent work total. Tuning thresholds is an ongoing job (status_board task, monthly).

## Risks and mitigations

- **Risk:** Phase 2 captures a flow that depends on transient UI state (e.g. a modal that only opens for new users) and the macro fails on subsequent runs.
  - **Mitigation:** the smoke-test step is mandatory before promotion. Failed smoke = handler stays in `proposed/` with a status_board correction task.
- **Risk:** Phase 3 over-clusters and drafts noise.
  - **Mitigation:** confidence threshold starts at 0.6, tune up if drafts are bad. Monthly review of accepted vs discarded drafts. The cron is suspendable via `schedule_pause` if it produces too much noise.
- **Risk:** A macro accumulates stale assumptions (a URL changes, a button moves) and rots silently.
  - **Mitigation:** every `macro.run` records success/failure. The runs log can drive a "macros that have failed >= 30% in the last 14d" status_board sweep. Stale macros get rewritten or deleted, not patched indefinitely.
- **Risk:** Recording captures sensitive non-password values (banking, health data).
  - **Mitigation:** Phase 2 includes a manual scrub step on promotion. Tate or I review the proposed handler line by line before it lands in the registry. The promotion gate is the security gate.

## Phase 1 priority handlers - the iOS release-pipeline pair (added 29 Apr 2026 15:25 AEST)

Triggered by Tate, 15:13 AEST: "why do we need this asc key bro.... just use the gui and it will work, i always redeploy roam via the gui working fine." This adds two named Phase 1 handlers to the dispatch queue, both targeting the iOS upload step that release.sh now calls instead of `xcrun altool --apiKey/--apiIssuer`. Doctrine: `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`. Strategic_Direction node: "GUI macros replace API keys for autonomous releases - use logged-in user sessions over generated programmatic credentials when both work."

### Handler A - `xcode-organizer-upload`

**Target host:** SY094 (MacInCloud Mac with Xcode 26.3) primary; Corazon if Xcode is ever installed there.

**Goal:** drive the Xcode > Window > Organizer > Distribute App flow to upload an `.ipa` to App Store Connect using Tate's logged-in Apple ID in Xcode.

**Params:** `{ipa_path: string}` - absolute path to the `.ipa` file on the target Mac (e.g. `~/projects/coexist/ios/App/build/export/App.ipa`).

**Flow (high-level):**

1. `process.launchApp` Xcode if not running, OR `process.listProcesses` to verify it's already running.
2. `input.shortcut [cmd, shift, n]` (or click File menu) to ensure no project is in foreground that would interfere with Organizer.
3. `input.shortcut [cmd, shift, 9]` opens Organizer (or `input.click` Window menu > Organizer).
4. Switch to "Archives" tab via `input.click` on the tab.
5. The most-recent archive should be auto-selected. Verify via `screenshot.screenshot` that the listed bundle id matches what `ipa_path` corresponds to. If not, find and click the right archive.
6. `input.click` "Distribute App" button.
7. Walk the wizard: pick "App Store Connect" > "Upload" (default selections work). `input.click` Next at each step.
8. On the final summary page, `input.click` "Upload".
9. Wait for completion via `screenshot.screenshot` polling. Success state: "Upload Successful" banner. Failure states: error dialogs with text - capture and return.
10. Return `{ok: true, build_uploaded: true, screenshot: <final_state.png>}` or `{ok: false, error: <captured_error>, screenshot: <error_state.png>}`.

**Constraints:**

- The `.ipa` path is informational for the macro. Xcode Organizer uploads from the matching `.xcarchive`, not the `.ipa`. The macro must verify the right archive is selected, OR convert the `ipa_path` flow into "build and re-archive in Xcode UI" if the archive is not present (deferred to v2 - v1 assumes the build came from the same Xcode install that holds the archive list).
- 2FA on the Apple ID: Xcode keeps an active session post-login. If 2FA fires, the macro screenshots the prompt and returns failure with `next_action: "tate enters 2FA code on Mac".` Status_board row inserted; release.sh halts until human action.
- 5-minute upload timeout. Apple sometimes hangs on processing.

**Open questions for the authoring fork:**

- Should the macro accept a `version_string` and auto-promote to a TestFlight group? Probably v2 - v1 just lands the build in ASC processing.

### Handler B - `transporter-upload`

**Target host:** SY094 primary; works on Corazon if Transporter is installed there.

**Goal:** drive the standalone Transporter app's drag-drop upload flow as a fallback to Xcode Organizer.

**Params:** `{ipa_path: string}` - absolute path to the `.ipa` file on the target Mac.

**Flow (high-level):**

1. `process.launchApp` Transporter (`/Applications/Transporter.app`).
2. `screenshot.screenshot` to verify the main window is reachable. If a sign-in prompt is showing, return `{ok: false, error: "Transporter not signed in", next_action: "tate signs in to Transporter on Mac"}`.
3. Two upload options:
   - **Drag-drop:** simulate via `input.drag` from a stored "Recent" panel or by opening Finder to the `.ipa` parent dir and dragging. This is brittle.
   - **Add app menu:** `input.click` File > "Add App" (or the + button in the toolbar) > the file picker opens > navigate to `ipa_path` via the Go-To-Folder shortcut (`input.shortcut [cmd, shift, g]`, type the path, enter).
4. Once added, the `.ipa` appears in the queue. `input.click` "Deliver" button.
5. Wait for completion. Success: "Upload successful" or "Delivered" status. Failure: error dialogs.
6. Return `{ok, ...}` shape same as Handler A.

**Why two handlers, not one:**

- Xcode Organizer is the canonical Apple-recommended path and fails most cleanly when Apple has issues. It's also the path Tate uses by default.
- Transporter is more deterministic for headless drag-drop automation and survives Xcode being mid-update or in a broken state.
- release.sh defaults to `xcode-organizer-upload`; can be overridden via `IOS_MACRO_NAME=transporter-upload` env var when Tate or the agent wants the alternate path.

### Brief for Phase 1 fork that ships these two handlers

**Goal:** add `xcode-organizer-upload` and `transporter-upload` to the macro registry, both runnable on SY094 (and degraded-runnable on Corazon if Xcode/Transporter ever land there).

**Repo:** `eos-laptop-agent` on Corazon (`D:\.code\eos-laptop-agent`). Branch: `feat/macro-ios-upload-handlers`.

**Files to add or modify:**

- `macros/handlers/xcode-organizer-upload.js` - the handler per flow above. Pure Node, composes only `input.*`, `screenshot.*`, `process.*` primitives.
- `macros/handlers/transporter-upload.js` - the handler per flow above.
- `macros/registry.json` - add both entries with name, handler path, param schema, description, tags `["ios", "release", "apple", "appstore"]`, target_host `"sy094"` (Corazon-compatible flag for future).
- `tests/macro-handlers/xcode-organizer-upload.test.js` - dry-run test using a mock Xcode Organizer state.
- `tests/macro-handlers/transporter-upload.test.js` - dry-run test using a mock Transporter state.
- `README.md` - extend the macro section with iOS-upload notes.

**Constraints (additional to Phase 1 base constraints in `macros-record-mode-and-auto-author-from-runs.md`):**

- The handlers MUST capture a final-state screenshot in the result, success or failure. release.sh logs the screenshot path to status_board for human visual-verify.
- Each handler MUST run `process.listProcesses` before launching to detect already-running instances and reuse them.
- 2FA-detected paths MUST short-circuit with a `next_action_by: "tate"` status_board insert payload in the return value, so release.sh can surface the blocker cleanly.
- Neither handler shall ever simulate the Apple ID password entry. If the GUI is asking for a password, the macro fails fast and returns.

**Test plan:**

1. Synthetic: feed a known Xcode Organizer screenshot to the handler's verification step, confirm correct branch chosen.
2. Live (SY094): `mcp__macros__macro_run({name: "xcode-organizer-upload", params: {ipa_path: "<recent-test-ipa>"}})`. Observe upload land in ASC processing. End-to-end ~10 minutes.
3. Live alt (SY094): same with `transporter-upload`. Observe upload land in ASC processing.
4. Failure: artificially break the Apple ID session in Xcode (sign out), run the macro, confirm clean failure with `next_action_by: tate`.
5. release.sh round trip: invoke `scripts/release.sh coexist ios testflight` end-to-end. Confirm the iOS branch dispatches the macro and observes success.

**Estimated effort:** 1 fork session, 3-4 hours of agent work, plus a 10-minute live test on SY094 once Tate confirms Xcode is signed in.

**Activation trigger:** dispatch when (a) Phase 1 base macros (fork_mojldsgx_7b55bf) merged + smoke-tested; (b) SY094 is reachable (`/api/health` 200); (c) Xcode 26.3 has an active Apple ID session per Xcode > Settings > Accounts.

**Status_board row to insert post-merge:** entity_type=`task`, name=`Author iOS upload macros (xcode-organizer-upload + transporter-upload)`, next_action=`Dispatch fork per macro-architecture-roadmap-2026-04-29.md Brief Phase-1-iOS`, next_action_by=`ecodiaos`, priority=2.

## Cross-references

- Doctrine: `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md`
- API-key-replacement doctrine: `~/ecodiaos/patterns/gui-macro-uses-logged-in-session-not-generated-api-key.md`
- Peer paradigm: `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md`
- Chrome-driving: `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md`
- Tate-blocked guard: `~/ecodiaos/patterns/exhaust-laptop-route-before-declaring-tate-blocked.md`
- iOS release flow: `~/ecodiaos/clients/app-release-flow-ios.md`
- iOS signing creds (older 3-path doctrine, the macro adds path 0): `~/ecodiaos/patterns/ios-signing-credential-paths.md`
- Release-candidate analysis: `~/ecodiaos/clients/release-candidate-analysis-2026-04-29.md`
- Release driver: `~/ecodiaos/scripts/release.sh` (iOS branch updated 29 Apr 2026 to default to macro path)
- Phase 1 fork: fork_mojldsgx_7b55bf
- Strategic_Direction (Neo4j): "GUI macros replace API keys for autonomous releases - use logged-in user sessions over generated programmatic credentials when both work"

## Activation triggers (when to dispatch each fork)

**Brief A (Phase 2):** dispatch when (1) Phase 1 PR is merged, (2) the agent has been restarted and `macro.list` returns the seeded handlers cleanly, (3) at least one hand-coded handler has been used in a real session without errors. Realistic window: 24-72 hours after Phase 1 merge.

**Brief B (Phase 3):** dispatch when (1) Phase 2 has shipped and at least 3 Tate-recorded handlers are in production, (2) `kv_store.macro.runs` has at least 50 rows, (3) the agent's input.* request log has 14 days of clean coverage. Realistic window: 2 weeks after Phase 2 ships.

Both forks should be assigned a default priority of P2 in status_board with `next_action_by=ecodiaos` once activation triggers fire.
