# Macro Runtime Pivot — From Bespoke vision.locate Loop to Anthropic computer-use Beta

**SUPERSEDED BY 20:25 AEST DIRECTIVE (29 Apr 2026).** Cowork is the 1stop shop for UI-driving tasks. The computer-use API path is now the OS-level / non-web fallback, not the primary macro runtime. See `~/ecodiaos/patterns/claude-cowork-is-the-1stop-shop-for-ui-driving-tasks.md`. The 22 web-driving macros migrate to Cowork-driven briefs (natural-language instructions handed to the side panel via `input.shortcut [ctrl+e]` + `input.type`), NOT cu.* loops. The 2 OS-level macros (`ios-release-pipeline`, `macincloud-ssh-session`) stay on the cu.* / shell path. Schema migration phase 1 (additive columns + legacy_step_array backfill) is still correct as it represents the legacy state regardless of which new runtime supersedes it. The remaining sections below describe the original cu.*-primary plan and remain accurate as the spec for the OS-level fallback path; the primary-runtime decision has flipped to Cowork.

---

**Author:** fork_mojvsm49_8087ec (scoping fork, no code changes)
**Date:** 2026-04-29 (AEST)
**Trigger (Tate, 19:54 AEST):** "we're doing what ive said we're doing wrong over and over by trying to recreate it ourselves when the tools already exist thanks to anthropic. Claude Desktop has these agentic capabilities already built in."
**Confidence pivot is feasible:** **High.** The Anthropic computer-use beta is the same primitive class we have been hand-rolling (screenshot + click + type + key + scroll), better-tested, server-side-loop-shaped, and reachable from the existing backend without changing the Corazon agent's transport.

---

## Section 1 — Anthropic computer-use API contract (verbatim from docs)

Source: `https://platform.claude.com/docs/en/docs/build-with-claude/computer-use` (fetched 2026-04-29).

### 1.1 Beta header + supported models

Two live beta header strings:

- `anthropic-beta: computer-use-2025-11-24` — supports Claude Opus 4.7, Claude Opus 4.6, Claude Sonnet 4.6, Claude Opus 4.5
- `anthropic-beta: computer-use-2025-01-24` — supports Sonnet 4.5, Haiku 4.5, Opus 4.1, Sonnet 4, Opus 4, Sonnet 3.7 (deprecated)

The 4.7-class header `computer-use-2025-11-24` is the one we will adopt. Tool-block `type` matches the header date: `computer_20251124`.

### 1.2 Quick-start request shape (verbatim cURL)

```bash
curl https://api.anthropic.com/v1/messages \
  -H "content-type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "anthropic-beta: computer-use-2025-11-24" \
  -d '{
    "model": "claude-opus-4-7",
    "max_tokens": 1024,
    "tools": [
      {
        "type": "computer_20251124",
        "name": "computer",
        "display_width_px": 1024,
        "display_height_px": 768,
        "display_number": 1
      }
    ],
    "messages": [
      { "role": "user", "content": "Save a picture of a cat to my desktop." }
    ]
  }'
```

### 1.3 Tool parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `type` | Yes | Tool version (`computer_20251124` or `computer_20250124`) |
| `name` | Yes | Must be `"computer"` |
| `display_width_px` | Yes | Display width in pixels |
| `display_height_px` | Yes | Display height in pixels |
| `display_number` | No | X11 display number (Linux only; ignored on Win/Mac) |
| `enable_zoom` | No | `computer_20251124` only. Set `true` to allow zoom action. Default `false`. |

### 1.4 Available actions (verbatim)

**Basic actions (all versions):**
- `screenshot` — capture display
- `left_click` — click at `coordinate: [x, y]`
- `type` — type `text` string
- `key` — press key combo, e.g. `"ctrl+s"`
- `mouse_move` — move cursor to `[x, y]`

**Enhanced (`computer_20250124` and up):**
- `scroll` — `coordinate`, `scroll_direction` (up/down/left/right), `scroll_amount`
- `left_click_drag` — click-and-drag between coordinates
- `right_click`, `middle_click`, `double_click`, `triple_click`
- `left_mouse_down`, `left_mouse_up` — fine-grained click control
- `hold_key` — hold a key for N seconds
- `wait` — pause between actions

**Enhanced (`computer_20251124` only, our target):**
- All of the above
- `zoom` — `region: [x1, y1, x2, y2]` to view a sub-rectangle at full resolution. Requires `enable_zoom: true` on the tool block.

**Modifier-key combos** are passed via the `text` parameter on `left_click` / `scroll` / etc.:

```json
{ "action": "left_click", "coordinate": [500, 300], "text": "ctrl" }
```

Accepted modifiers: `shift`, `ctrl`, `alt`, `super` (Cmd / Win key).

### 1.5 Action-result wire format

The model emits `tool_use` content blocks. The host returns a `tool_result` content block on the next user turn. Screenshots come back as base64-encoded PNG/JPEG image blocks inside the `content` array of the `tool_result`.

Error response shape (verbatim from docs):

```json
{
  "role": "user",
  "content": [
    {
      "type": "tool_result",
      "tool_use_id": "toolu_01A09q90qw90lq917835lq9",
      "content": "Error: Failed to capture screenshot. Display may be locked or unavailable.",
      "is_error": true
    }
  ]
}
```

### 1.6 Agent loop (verbatim from docs, Python)

```python
while True and iterations < max_iterations:
    iterations += 1
    response = client.beta.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=messages,
        tools=tools,
        betas=[beta_flag],
    )
    response_content = response.content
    messages.append({"role": "assistant", "content": response_content})

    tool_results = []
    for block in response_content:
        if block.type == "tool_use":
            result = run_tool(block.name, block.input)
            tool_results.append(
                {"type": "tool_result", "tool_use_id": block.id, "content": result}
            )
    if not tool_results:
        return messages
    messages.append({"role": "user", "content": tool_results})
```

Termination: when the assistant turn contains no `tool_use` blocks, the task is done and the assistant's text is the final answer.

### 1.7 Pricing / token costs

**Auth model: Anthropic SDK OAuth via Max account, not console API key.** Token costs apply against the Max sub's quota the same way the OS session's normal messages.create calls do.

- **System-prompt overhead:** the beta adds 466-499 tokens to the system prompt.
- **Tool definition:** 735 input tokens per request for the computer-use tool block (4.x and 3.7 models).
- **Per-iteration screenshot:** standard vision pricing applies. API constrains images to ~1568 px on long edge, ~1.15 megapixels (Opus 4.7 lifts the long edge to 2576 px and is 1:1 with image pixels — no scale conversion needed).
- **Per-iteration overhead estimate:** ~735 (tool def, prompt-cached after first turn) + ~1500-2000 (screenshot image tokens) + ~200-500 (model reasoning + action output) ≈ **2.5-3k tokens per iteration**, of which only the screenshot + reasoning are uncached.

### 1.8 Documented limitations

Verbatim summary from the docs:

1. **Latency:** computer-use is too slow for human-AI interactive use. Use it for background tasks, automated testing, things where speed isn't critical.
2. **Computer-vision accuracy:** Claude can hallucinate coordinates. Use extended thinking + verification screenshots after each step.
3. **Tool-selection accuracy:** model may pick wrong action. Prompt carefully on niche apps.
4. **Scrolling:** improved in 3.7+ via dedicated scroll action.
5. **Spreadsheets:** `left_mouse_down`/`up` + modifier-clicks improve cell selection.
6. **Account creation / social-platform impersonation:** capability deliberately limited.
7. **Prompt injection from screen content:** classifiers run on prompts and may steer the model to ask for human confirmation when a potential injection is detected. Opt-out requires Anthropic support contact.
8. **Coordinate scaling:** see §1.9 below.

### 1.9 Coordinate scaling (impact on Corazon)

The API downsamples images on its side to ≤1568 px long edge / ≤1.15 MP for pre-4.7 models (4.7 lifts to 2576 px, 1:1). Claude returns coordinates in the *downsampled* space. Our agent must scale them back up to the real screen space before clicking. The docs ship a `get_scale_factor` snippet (Python + TS) — port to JS for `eos-laptop-agent`. With Opus 4.7 on Corazon's typical 1920×1080 display, the long edge (1920) is under 2576 so coords are 1:1 — **no scaling needed** for the 4.7-class beta on a single laptop screen. This simplifies the implementation considerably.

---

## Section 2 — Claude Desktop / Claude for Chrome vs computer-use API: decision

### 2.1 What I could verify

**Computer-use beta API:** fully documented, programmatically driveable from any backend over standard `messages.create`. Schema-less tool baked into the model. ZDR-eligible. This is the canonical Anthropic surface for "drive a computer with Claude."

**Claude Desktop / Claude for Chrome:** end-user products. Claude Desktop is the macOS/Windows native chat client. Claude for Chrome is a browser extension (Anthropic's blog at `claude.com/blog/claude-for-chrome`). Both ship agentic features for the human end-user. **Neither exposes a documented programmatic third-party API to drive them from a server.** The Anthropic "platform" docs only describe `messages.create` + the computer-use tool block; there is no `claude-desktop-agent` REST endpoint, no Chrome-extension RPC, no SDK that targets Desktop's agent loop.

(Caveat: I attempted to fetch `claude.com/blog/claude-for-chrome` and `platform.claude.com/docs/en/api/claude-code-sdk` and they returned the long-context-beta paywall on this fork's WebFetch path — I have read the canonical computer-use doc verbatim, and I read the redirect chain that confirms Claude for Chrome is a blog post / consumer landing page, not an API surface.)

### 2.2 The decision

**Use the computer-use beta API directly. Do NOT try to drive Claude Desktop or Claude for Chrome.**

Reasoning:

1. **Programmatic surface:** computer-use is an HTTP API. Claude Desktop / Chrome are GUI products. To drive Desktop from EcodiaOS we would have to GUI-automate Desktop — circular: we'd be using bespoke `input.*` to drive the very thing whose purpose is to remove `input.*`.
2. **Same intelligence, no extra hops:** Desktop and the API both call the same Anthropic models. There is no capability gain from going through Desktop, only added latency and a fragile GUI dependency.
3. **Account / billing clarity:** computer-use beta runs on our existing API key (under whichever organization we point it at — likely the `code@ecodia.au` Claude Max if that's the budget pool, see §7 cost notes). Desktop chat lives inside the Claude Max consumer surface and has no programmatic billing channel.
4. **Tate's framing was "the tools already exist."** The tool that exists is the computer-use API. Claude Desktop is the consumer manifestation; the API is the developer-platform manifestation. We are a developer platform (EcodiaOS).
5. **ZDR + audit trail:** computer-use is ZDR-eligible. We control message history, screenshots, action logs end-to-end. That matters for the macro-runbook compliance discipline (last-run outcome, validated_v1 status, etc.).

The Corazon agent stays. It becomes the *executor* of Anthropic's tool actions — not the brain. The model lives in our API call; the agent provides screenshot + 5 primitive actuators.

---

## Section 3 — New primitive set on agent + new conductor route

### 3.1 Agent-side primitives (the only 5 we need)

Replace the bespoke 9-module / 47-tool surface with a minimal computer-use executor module. Everything else (`shell.shell`, `filesystem.*`, `process.*`, `browser.*`, `chrome.*`, `macro.*`, `screenshot.screenshot` for non-macro use) stays — those are valuable independent peer-paradigm tools (see `corazon-is-a-peer-not-a-browser-via-http.md`). The change is **only to the macro runtime**, not to Corazon's general tool surface.

New module: `tools/computerUseExecutor.js`. Exposed under namespace `cu.*`:

| Primitive | Purpose | Implementation |
|---|---|---|
| `cu.screenshot` | Capture full display, return `{image: <base64 PNG>, width, height}` | Wrap existing `screenshot.screenshot` (already exists; keep). Resize to 2560×... for 4.7 if multi-monitor. |
| `cu.click` | `{x, y, button?, modifiers?, count?}` — execute click. Accepts `button = left/right/middle`, `modifiers = [shift,ctrl,alt,super]`, `count = 1/2/3` | Wraps existing `input.click` + modifier handling. |
| `cu.type` | `{text}` — type a literal string | Wraps existing `input.type`. |
| `cu.key` | `{key}` — press a key or combo (e.g. `"ctrl+l"`, `"enter"`, `"f5"`) | Wraps existing `input.key` / `input.shortcut`. |
| `cu.scroll` | `{x, y, direction, amount, modifiers?}` — scroll by N "ticks" at coords | Wraps existing `mouse.scroll` (or new shim). |

That's it. Five primitives. Drag, hold-key, mouse-down/up, double/triple-click are all expressible by the conductor as compositions of these five (or we can add `cu.drag` and `cu.holdKey` later — explicitly NOT required for v1).

**Anything `vision.locate` did, the Anthropic model now does internally on the screenshot it receives.** The agent has no vision proxy any more. No "find this button," no "OCR this label." The screenshot is the input; coordinates are the output.

### 3.2 Conductor backend — new route

`POST /api/macros/run-via-computer-use` on `ecodiaos-backend`.

**Request:**

```json
{
  "name": "stripe-create-customer-and-invoice",
  "params": {
    "customer_name": "Resonaverde",
    "customer_email": "angelica@resonaverde.com.au",
    "line_items": [{"description": "Strategy session", "amount_cents": 50000}],
    "send_or_draft": "draft"
  },
  "max_iterations": 40,
  "model": "claude-opus-4-7"
}
```

**Server-side behaviour:**

1. Look up `macro_runbooks` row by `name`. Read `brief` (new column, see §4).
2. Resolve `params` placeholders — interpolate into the brief.
3. Resolve `@kv:creds.*` references — pull from `kv_store`, inject into a `<robot_credentials>` XML block per Anthropic's prompting tips. Mark as redacted in logs.
4. Open the agent loop:
   - Take initial screenshot via `POST :7456/api/tool` `cu.screenshot`.
   - Build first user message: `[brief text, robot_credentials, screenshot image block]`.
   - POST to `https://api.anthropic.com/v1/messages` with the computer-use tool defined.
   - Parse `content`: for each `tool_use` block:
     - Map action name to `cu.*` namespace.
     - Forward to Corazon agent over HTTP, get result.
     - If action was `screenshot`, the result is the new image; package as `tool_result` with image content block.
     - Else result is text confirmation (or error).
   - Append assistant turn + user-tool-results turn to messages list. Loop.
5. Terminate when assistant turn has no `tool_use` blocks OR `iterations >= max_iterations` OR `abort.check` flips OR a `question.surface` action is emitted (see §3.3).
6. Persist to `macro_run_log` (existing or new): `{run_id, macro_name, iterations, total_input_tokens, total_output_tokens, screenshot_count, outcome, final_assistant_text}`.

**Response:**

```json
{
  "run_id": "run_...",
  "outcome": "success" | "max_iterations" | "aborted" | "question_surfaced" | "error",
  "iterations": 8,
  "tokens": { "input": 14_500, "output": 2_100 },
  "final_message": "Customer created (cus_...) and invoice draft saved. Stripe ID: in_...",
  "question": null
}
```

### 3.3 Preserved semantics

- **`abort.check`** — conductor polls a flag (kv_store or in-memory) between iterations; if set, terminates the loop and returns `outcome: "aborted"`.
- **`question.surface`** — model can request human input by emitting a custom tool we add alongside computer-use: `tools: [computer-use-tool, question-surface-tool]`. When invoked, the conductor pushes the question to status_board / SMS Tate / `os_session/message`, suspends the run, and resumes when an answer is provided. (Same semantics as today; new transport layer.)

### 3.4 What goes away on the agent side

- `vision.locate` — the API now sees the screenshot directly.
- `runbook.run` (the iterator) — the conductor loop replaces it.
- `input.shortcut` (collapsed into `cu.key` which accepts combos like `"ctrl+l"`).
- `input.paste` / `input.fast_type` — never needed; computer-use handles typing.
- The Anthropic-vision proxy (`/api/laptop-vision/locate`) on `ecodiaos-backend` — deleted.

What stays on the agent (untouched by this pivot):
- `shell.shell`, `filesystem.*`, `process.*`, `browser.*`, `chrome.*`, `screenshot.screenshot` (exposed as `cu.screenshot` AND retained as `screenshot.screenshot` for non-macro use).
- `keyboard.*`, `mouse.*`, `input.*` — kept as the underlying actuators that `cu.*` shims call. We deprecate them for *macro* purposes but they remain for ad-hoc peer-paradigm work.
- `macro.*` (AutoHotkey) — orthogonal to runbook macros, keep.

---

## Section 4 — `macro_runbooks` schema diff

### Current schema (verbatim from `db_describe_table`)

```
id              uuid PK
name            text UNIQUE
version         integer DEFAULT 1
steps           jsonb NOT NULL          -- array of {action, params, vision_target_id?, validation_id?}
vision_targets  jsonb                   -- [{id, description, anchor?}, ...]
validations     jsonb                   -- [{id, kind, expect}, ...]
authored_by     text DEFAULT 'eos-agent'
authored_at     timestamptz DEFAULT now()
last_run_at     timestamptz
last_run_outcome text
description     text
goal_state      text
status          text DEFAULT 'untested_spec'
```

### Target schema (post-pivot)

```
id              uuid PK
name            text UNIQUE
version         integer DEFAULT 1
brief           text NOT NULL          -- NEW. The natural-language instruction for computer-use.
inputs_schema   jsonb                  -- NEW. Optional JSONSchema for params (was implicit in steps' {{var}} placeholders).
goal_state      text                   -- KEEP. Shown to the model as success criterion.
authored_by     text DEFAULT 'eos-agent'
authored_at     timestamptz DEFAULT now()
last_run_at     timestamptz
last_run_outcome text
description     text                   -- KEEP. Human-readable description.
status          text DEFAULT 'legacy_step_array' -- enum extended

-- Archived, not deleted:
legacy_steps           jsonb            -- RENAMED from `steps`. Keep for forensics + rollback.
legacy_vision_targets  jsonb            -- RENAMED from `vision_targets`.
legacy_validations     jsonb            -- RENAMED from `validations`.
```

### Status enum extension

Current values observed: `untested_spec`, `validated_v1` (per doctrine).

Add: `legacy_step_array` — applied to all 24 existing rows during migration. They cannot be replayed on the new runtime until a `brief` is authored and status flips to `untested_spec` (then `validated_v1` after first successful real run, per `macros-must-be-validated-by-real-run-before-codification.md`).

### Migration SQL sketch (NOT executing this turn — Tate review first)

```sql
ALTER TABLE macro_runbooks
  ADD COLUMN brief text,
  ADD COLUMN inputs_schema jsonb,
  ADD COLUMN legacy_steps jsonb,
  ADD COLUMN legacy_vision_targets jsonb,
  ADD COLUMN legacy_validations jsonb;

UPDATE macro_runbooks SET
  legacy_steps = steps,
  legacy_vision_targets = vision_targets,
  legacy_validations = validations,
  status = 'legacy_step_array'
WHERE status IN ('untested_spec', 'validated_v1');

-- After all 24 macros have a `brief` populated:
ALTER TABLE macro_runbooks
  DROP COLUMN steps,
  DROP COLUMN vision_targets,
  DROP COLUMN validations,
  ALTER COLUMN brief SET NOT NULL;
```

---

## Section 5 — Migration plan: 24 existing macros → natural-language briefs

**Note:** the brief said "22 macros." Actual count is **24**. Listed by name (alphabetical):

| # | Macro name | Status today | Proposed 1-line brief (natural language for computer-use model) |
|---|---|---|---|
| 1 | apple-asc-add-tester | untested_spec | "Open https://appstoreconnect.apple.com, navigate to the {{app_name}} app's TestFlight tab, open the {{group_name}} tester group, click Testers, click +, enter `{{tester_email}}`, save, and confirm the toast." |
| 2 | apple-asc-login | untested_spec | "Open https://appstoreconnect.apple.com in the active Chrome window. If logged in (you see the Apps grid), stop. Else type `{{kv:creds.apple.email}}` into the Apple ID field, press Continue, type `{{kv:creds.apple.password}}` and Continue. If a 2FA SMS prompt appears, surface a question to the conductor with field `apple_2fa_code` and wait." |
| 3 | apple-developer-login | untested_spec | "Open https://developer.apple.com/account in the active Chrome. Same login flow as Apple ASC; stop when the Account dashboard is visible." |
| 4 | bitbucket-pr-create | untested_spec | "On bitbucket.org/{{workspace}}/{{repo_slug}}, click Create pull request, set source = `{{source_branch}}`, destination = `{{destination_branch}}`, set title `{{title}}`, paste `{{description}}` into the body, click Create. Capture the resulting PR URL from the address bar." |
| 5 | calendar-create-event | untested_spec | "Open https://calendar.google.com (Default profile, code@ecodia.au). Click Create > Event. Title `{{title}}`. Set start `{{start_iso}}` and end `{{end_iso}}` (use the time pickers). If `{{attendees}}` is non-empty, add each as a guest. Click Save and confirm." |
| 6 | canva-export-design | untested_spec | "Open the Canva design at `{{design_url}}`. Click Share > Download. Set file type to `{{format}}` (png/jpg/pdf/mp4). Click Download. Wait for the browser download to complete; report the saved filename." |
| 7 | coexist-admin-login | untested_spec | "Open https://app.coexistaus.org. Type `{{kv:creds.coexist.email}}` and `{{kv:creds.coexist.password}}` into the login form, click Sign in, stop when the admin dashboard is visible." |
| 8 | drive-share-doc | untested_spec | "Open `{{doc_url}}` in Default Chrome. Click Share. Type `{{share_email}}` into the people field, set permission to `{{permission}}` (viewer/commenter/editor), click Send (or Copy link if `{{notify}}` is false)." |
| 9 | github-create-issue | untested_spec | "On github.com/{{org}}/{{repo}}/issues, click New issue, type title `{{title}}` and body `{{body}}`. If `{{labels}}` is non-empty, click Labels and select each. Click Submit new issue. Capture the issue URL." |
| 10 | github-create-pr | untested_spec | "On github.com/{{org}}/{{repo}}, click Pull requests > New, set base = `{{base}}` head = `{{head}}`, title `{{title}}`, body `{{body}}`. Click Create pull request. Capture the PR URL." |
| 11 | github-login | untested_spec | "Open https://github.com/login. Type `{{kv:creds.github.username}}` and `{{kv:creds.github.password}}`, click Sign in. If a 2FA prompt appears, surface a question with field `github_2fa_code` and wait." |
| 12 | gmail-login-tate | untested_spec | "Switch Chrome to Profile 1 (Tate's personal profile). Open https://mail.google.com and confirm the inbox is loaded as `tate@ecodia.au`. If a re-auth prompt shows, type `{{kv:creds.gmail.tate.email}}` and `{{kv:creds.gmail.tate.password}}`." |
| 13 | gmail-send | untested_spec | "Open https://mail.google.com (Default profile = code@ecodia.au unless `{{from}}` says otherwise). Click Compose. Type `{{to}}` in the To field, `{{subject}}` in Subject, `{{body}}` in the body. Click Send. Confirm the 'Message sent' toast." |
| 14 | ios-release-pipeline | untested_spec | "Drive a Roam/Co-Exist/Chambers iOS release end-to-end: SSH to MacInCloud SY094, archive the {{app_slug}} workspace in Xcode (`xcodebuild archive`), upload to App Store Connect, then in ASC web UI verify the build appeared, fill metadata `{{release_notes}}`, submit for TestFlight review. This is a multi-stage macro — surface a question after each stage to the conductor." |
| 15 | macincloud-ssh-session | untested_spec | "Not a GUI macro — handled by VPS shell using `sshpass + kv:creds.macincloud`. Skip the computer-use loop; this becomes a server-side helper, not a runbook." (Recommend reclassifying out of `macro_runbooks` entirely — see §6 for action.) |
| 16 | resend-rotate-api-key | untested_spec | "Open https://resend.com/api-keys. Click Create API key, name it `ecodiaos-{{date}}`, copy the generated key, post it to kv_store at `creds.resend.api_key`. Then click Revoke on the previous key (named `ecodiaos-{{prev_date}}`)." |
| 17 | roam-admin-login | untested_spec | "Open `{{kv:creds.roam.admin.url}}`. Type `{{kv:creds.roam.admin.email}}` and `{{kv:creds.roam.admin.password}}`. Stop when the admin dashboard is visible." |
| 18 | stripe-create-customer-and-invoice | untested_spec | "On https://dashboard.stripe.com/customers, click + New customer, fill name `{{customer_name}}` and email `{{customer_email}}`, save. Then on the customer's page click Create invoice, add line items `{{line_items}}` (each: description, qty, unit price), set due date `{{due_date}}`. If `{{send_or_draft}}` = send, click Send invoice; else Save as draft. Capture the invoice ID." |
| 19 | stripe-dashboard | untested_spec | "Open https://dashboard.stripe.com/login. Type `{{kv:creds.stripe.email}}` and `{{kv:creds.stripe.password}}`. If 2FA SMS / device-confirm appears, surface question. Stop on the dashboard home." |
| 20 | supabase-dashboard | untested_spec | "Open https://supabase.com/dashboard, log in with `{{kv:creds.supabase.email}}` and `{{kv:creds.supabase.password}}` if needed, navigate to project `{{project_ref}}`. Stop on the project home page." |
| 21 | vercel-add-env-var | untested_spec | "On https://vercel.com/{{team}}/{{project}}/settings/environment-variables, click Add New, key `{{key}}`, value `{{value}}`, environments `{{envs}}` (production/preview/development). Click Save." |
| 22 | vercel-redeploy | untested_spec | "On https://vercel.com/{{team}}/{{project}}, click the latest deployment, click the ⋯ menu, click Redeploy, confirm. Capture the new deployment URL." |
| 23 | xero-create-bill | untested_spec | "On https://go.xero.com Business > Bills to pay > New Bill. Set contact `{{contact_name}}`, reference `{{reference}}`, date `{{date}}`, due date `{{due_date}}`. For each line in `{{line_items}}`, add description, qty, unit price, account code, tax rate. Click Approve (or Save as draft if `{{save_as_draft}}` is true). Capture the bill ID." |
| 24 | zernio-create-post | untested_spec | "On https://app.zernio.com, click New Post. Select accounts `{{accounts}}`. Paste body `{{body}}`. Upload `{{media}}` if present. Set scheduled time `{{schedule_at}}` or leave blank to publish now. Click `{{publish_or_schedule_or_draft}}`. Capture the resulting post ID(s)." |

**Migration policy:** I am NOT writing these briefs to the DB this turn. Each of the 24 needs a 5-minute review against its current `description` field (some have richer context than I've reproduced) before flipping `status` to `untested_spec` on the new runtime and scheduling a real-run validation per `macros-must-be-validated-by-real-run-before-codification.md`.

**Reclassify-out candidate:** `macincloud-ssh-session` — not a GUI macro at all. It's a 9-step shell-only flow. Recommend moving it to a server-side helper and dropping the row.

---

## Section 6 — Deletion list

**DO NOT DELETE THIS TURN.** Tate review first; deletion is a separate dispatch.

### 6.1 ecodiaos-backend (VPS, ~/ecodiaos)

| Path | Action | Reason |
|---|---|---|
| `src/routes/laptopVision.js` | DELETE | The Anthropic-vision proxy (`/api/laptop-vision/locate`) is replaced by the model seeing the screenshot directly via computer-use. |
| `src/services/laptopVisionService.js` (if present) | DELETE | Same. |
| `src/services/runbookExecutor.js` (if it exists in this repo) | DELETE or refactor | The bespoke step-iterator is replaced by the computer-use agent loop. |
| `src/routes/macros.js` (if it exists with the old runbook.run plumbing) | KEEP, refactor | Becomes the home of `POST /api/macros/run-via-computer-use`. CRUD for `macro_runbooks` (list/get/save brief) stays. |

### 6.2 eos-laptop-agent (Corazon, `D:\.code\eos-laptop-agent`)

| Path | Action | Reason |
|---|---|---|
| `tools/vision.js` | DELETE | Vision proxy + locate primitive. Computer-use handles vision. |
| `tools/runbook.js` | DELETE the `runbook.run` handler | The iterator runs server-side now. Keep `runbook.save / load / list` only if they were CRUD for a local cache; if all CRUD goes through the backend, delete the whole module. |
| `tools/input.js` `paste` / `fast_type` handlers (queued but NOT yet built) | DO NOT BUILD | Per brief — computer-use handles typing. |
| `tools/computerUseExecutor.js` | NEW | The 5-primitive executor (cu.screenshot, click, type, key, scroll). |
| `tools/screenshot.js` | KEEP | Both `screenshot.screenshot` (general use) AND used by `cu.screenshot` shim. |
| `tools/input.js` | KEEP | Underlying actuators that `cu.*` shims call. Deprecated for macro use, retained for ad-hoc peer work. |
| `tools/keyboard.js`, `tools/mouse.js` | KEEP | Same as input.js — peer-paradigm utility. |
| `tools/macro.js` (AutoHotkey) | KEEP | Orthogonal to runbook macros. |
| `tools/browser.js`, `tools/chrome.js`, `tools/shell.js`, `tools/filesystem.js`, `tools/process.js` | KEEP, untouched | Peer-paradigm tools, not part of the macro runtime. |

### 6.3 Doctrine files

| Path | Action |
|---|---|
| `~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md` | SUPERSEDE. Author replacement: `macros-run-via-anthropic-computer-use-not-bespoke-vision.md`. The supersession note in the new file references this one and the trigger event. |
| `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` | NARROW. Still correct for ad-hoc peer-paradigm Chrome control (when conductor wants to navigate one tab). For *macro* use, computer-use is now the primary surface. Add a "scope" note: this rule applies to one-off conductor actions, not codified macros. |
| `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` | KEEP, mostly. The "record mode" idea still holds — first real run becomes the validation evidence — but the artefact stored is no longer a step-array; it's the brief + the message log. Update accordingly. |
| `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` | KEEP unchanged. The validation discipline applies regardless of runtime. |
| `~/ecodiaos/patterns/eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` | KEEP. Still applies to the new `computerUseExecutor.js` module. |
| `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` | KEEP unchanged. Peer paradigm is unaffected. |

### 6.4 CLAUDE.md (~/ecodiaos/CLAUDE.md)

Edits required (separate fork after Tate approval):

- Replace the "Macro authoring doctrine" paragraph (currently references `vision.locate (when shipped)`) with a paragraph pointing at the new computer-use runtime and the new `cu.*` primitive set.
- Update the "Available tools" list under the laptop-agent section: drop `vision.*` (planned), add `cu.*`.
- Add a `~/ecodiaos/docs/secrets/anthropic-api.md` stub if we need a programmatic API key separate from Claude Max (see §7).

---

## Section 7 — Effort estimate (LOC delta)

| Component | LOC added | LOC deleted | Net |
|---|---|---|---|
| `tools/computerUseExecutor.js` (new) | ~150 | 0 | +150 |
| `tools/vision.js` (delete) | 0 | ~200 (estimate; not read this turn) | -200 |
| `tools/runbook.js` `run` handler (delete) | 0 | ~300 | -300 |
| `tools/runbook.js` save/load/list (keep or delete CRUD) | 0 | ~100 (if move to backend) | -100 |
| `src/routes/laptopVision.js` (backend, delete) | 0 | ~80 | -80 |
| `src/routes/macros.js` `runBespoke` handler (refactor) | 0 | ~250 | -250 |
| `src/routes/macros.js` `runViaComputerUse` handler (new) | ~250 | 0 | +250 |
| `src/services/anthropicComputerUseClient.js` (new) | ~200 | 0 | +200 |
| `src/services/macroRunLogger.js` (new or extend) | ~80 | 0 | +80 |
| Migration SQL + `migrations/NNNN_macro_pivot.sql` | ~30 | 0 | +30 |
| Updated doctrine MD files | ~150 | ~150 | 0 |
| **Total** | **~860** | **~1,080** | **-220 LOC net deletion** |

**Net effect:** ~220 LOC fewer in the system, replaced with a thinner, more general primitive set + Anthropic doing the heavy vision work. The win isn't the LOC delta — it's that we stop maintaining a parallel implementation of something Anthropic ships and improves with every model release.

**Effort to ship:** ~6-8 hours of focused fork work, broken into:

1. (1h) Schema migration + status enum extension. Add columns. Backfill `legacy_*`. Set status = `legacy_step_array`.
2. (2h) `computerUseExecutor.js` on agent. PM2 restart. Verify via `cu.screenshot`, `cu.click`, `cu.type` happy path.
3. (2h) `anthropicComputerUseClient.js` + `runViaComputerUse` route. Mock test against a known-simple macro (e.g. `gmail-send` with a test gmail draft).
4. (1h) `question.surface` custom tool integration into the loop.
5. (1-2h) Author the 24 briefs (or batch-fork 6 forks of 4 briefs each, but that's a separate question).
6. Validation runs per `macros-must-be-validated-by-real-run-before-codification.md`.

---

## Section 8 — Performance comparison

### 8.1 Bespoke vision.locate loop (current path, never validated end-to-end)

Per iteration (one macro step):
- Take screenshot (Corazon → VPS): ~200 ms
- VPS proxy POST to Anthropic vision (`/api/laptop-vision/locate`): ~1.2-2.5 s round trip per locate (single-element search, no agent loop, just "find this anchor")
- Send `input.click` to Corazon: ~80-150 ms
- Total per step: **~1.5-2.8 s + zero model reasoning between steps**, but with NO awareness of failure modes — the iterator just blindly runs the next step.
- Failure recovery: ad-hoc, requires hand-coded validation hooks.

For a 25-step macro: ~38-70 s, with brittleness multiplier (any one step's anchor mismatch = whole macro halts).

### 8.2 computer-use loop (proposed path)

Per iteration (one model decision + one action):
- Screenshot capture (agent): ~150-250 ms
- Resize + base64 encode: ~50-100 ms
- POST to `api.anthropic.com/v1/messages`: ~3-6 s for Opus 4.7 with ~2-3k input tokens (cached after first turn) + reasoning + tool-use output
- Action dispatch to Corazon: ~80-150 ms
- Total per iteration: **~3.5-6.5 s**

For a "25-step" macro the model typically takes fewer iterations than hand-coded steps (it can do "click and type the search box" in one tool_use, where the bespoke runbook had 3 separate steps). Assume 15-18 iterations average → **55-120 s total**.

**Headline:** computer-use is **~1.5-2x slower per macro** than the bespoke loop *would* be if the bespoke loop worked. But:

1. The bespoke loop **doesn't reliably work** — that's why Tate triggered this pivot. The "fast" bespoke path is theoretical; the real path includes retries, anchor tweaks, manual debugging, weeks of validation.
2. Computer-use is **self-healing**. If a button moves or a modal pops up, the model sees it and adapts. The bespoke loop halts.
3. Latency budget is fine for our use cases — these are background macros (Stripe invoice, Vercel redeploy, Xero bill), not interactive flows. Per Anthropic's own caveat: "Focus on use cases where speed isn't critical."
4. Token cost per macro: ~50-90k tokens (15-18 iterations × ~3k each). At Claude Max economics this is sub-cent. At metered API: roughly $0.40-0.80 per macro run with Opus 4.7. Acceptable for the volume we run (handful per day).

### 8.3 Reliability comparison

| Dimension | Bespoke vision.locate | computer-use (proposed) |
|---|---|---|
| Recovers from UI changes | No — anchor mismatch halts | Yes — model sees the new UI |
| Handles unexpected modals | No — breaks the step iterator | Yes — model dismisses or surfaces |
| Failure visibility | Step-level only | Full natural-language reasoning trace |
| Maintenance per macro | High (anchors drift, validations need updating) | Low (brief is stable; model adapts) |
| Cold-start authoring time | ~30-60 min per macro (step + anchor + validation) | ~5 min per macro (one paragraph) |
| Validation discipline | Per-step asserts | Per-run goal_state check by the model |

---

## Open questions for Tate (do not block on these to read this spec)

1. **Q1 RESOLVED 2026-04-29 20:22 AEST:** EcodiaOS already runs on Max account via Anthropic SDK OAuth. Computer-use beta is an added tool block + beta header on the existing transport. No new credential, no new spend.
2. **Model selection.** `claude-opus-4-7` vs `claude-sonnet-4-6`. Opus 4.7 is the default for the `2025-11-24` beta and gets the 2576-px long edge (no scaling needed on Corazon). Sonnet 4.6 is cheaper. Recommend Opus 4.7 for all macro runs given the latency-not-critical context — accuracy beats cost.
3. **Migration order.** All 24 macros set to `legacy_step_array` at once, then briefs authored on demand as each macro is needed for a real run? Or batch-author all 24 briefs upfront in a 6-fork wave? Recommend on-demand: never spend the validation budget on a macro that may not be used.
4. **Reclassify `macincloud-ssh-session` out of `macro_runbooks`?** It's not a GUI macro at all.

---

## Cross-references

- Anthropic computer-use docs: `https://platform.claude.com/docs/en/docs/build-with-claude/computer-use` (beta `computer-use-2025-11-24`, model `claude-opus-4-7`, tool block `computer_20251124`).
- Reference implementation: `https://github.com/anthropics/anthropic-quickstarts/tree/main/computer-use-demo`.
- `~/ecodiaos/patterns/macros-must-be-validated-by-real-run-before-codification.md` — validation discipline, unchanged.
- `~/ecodiaos/patterns/macros-record-mode-and-auto-author-from-runs.md` — first-run-as-evidence, adapt artefact format.
- `~/ecodiaos/patterns/macros-learn-by-doing-vision-first-run-with-question-surface.md` — to be SUPERSEDED.
- `~/ecodiaos/patterns/drive-chrome-via-input-tools-not-browser-tools.md` — NARROWED to ad-hoc peer use only.
- `~/ecodiaos/patterns/eos-laptop-agent-module-cache-requires-restart-after-handler-swap.md` — applies to new `computerUseExecutor.js`.
- `~/ecodiaos/patterns/corazon-is-a-peer-not-a-browser-via-http.md` — peer-paradigm preserved.

---

---

## Section 9 — Recommendation: which of three integration paths wins

**Tate clarification 19:58 AEST:** github-login macro replay FAILED (expected). Three integration paths to evaluate equally — Anthropic computer-use API (Path 1), Claude Desktop on Corazon (Path 2), Claude for Chrome browser extension (Path 3). Probe Path 2 and 3 first; API is fallback.

I probed Corazon directly (the only reliable signal — public Anthropic blog/extension-store URLs are paywall-gated on this fork's WebFetch path). Findings are concrete from Corazon's installed-app manifests, registry, native-messaging-host config, and listening-socket state.

### 9.1 Path 2: Claude Desktop (Windows MSIX app, version 1.1.6452.0)

**Installed on Corazon: YES.** Verified path: `C:\Program Files\WindowsApps\Claude_1.1.6452.0_x64__pzs8sxrjxfjjc\app\Claude.exe`. Publisher signed by Anthropic, PBC. Currently running (multiple Electron child processes). Tate's Claude Max account is signed in.

**Programmatic surface from a third-party server (us): NO.** Detailed evidence:

- **`claude://` URL scheme handler IS registered** (`AppxManifest.xml` line 101-103: `<uap3:Protocol Name="claude" Parameters="&quot;%1&quot;" />`). But this only opens the desktop app at a URL — equivalent to clicking a deeplink. There is no documented schema for "execute this agent task" via the URL. From PowerShell: `Start-Process "claude://chat/new"` opens the app, but won't dispatch a task.
- **`cowork-svc.exe` background service IS registered** (`AppxManifest.xml` line 104-122, runs as `app\resources\cowork-svc.exe`, `Category="windows.service"`, firewall rules opened TCP in/out). This was the most promising candidate for a local HTTP server. **But the live probe at this moment showed `cowork-svc.exe` not in the process list, with no listening sockets.** The service registration is present but the daemon was not active during probe — likely starts on demand when the Chrome extension connects to it, or only when Desktop is in agent mode. Either way, no persistent TCP API for us to call.
- **Native messaging host is registered for ALL major Chromium browsers** (Chrome, Brave, Edge, Chromium, Arc, Vivaldi, Opera) under `com.anthropic.claude_browser_extension`. The native-host manifest at `C:\Users\tjdTa\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\ChromeNativeHost\com.anthropic.claude_browser_extension.json` declares: `"type": "stdio"` and `allowed_origins: ["chrome-extension://dihbgbndebgnbjfmelmegjepbnkhlgni/", "chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/", "chrome-extension://dngcpimnedloihjnnfngkgjoidhnaolf/"]`. **Stdio-only, allowlisted to three Chrome extension IDs (Claude stable/beta/canary).** A third-party process cannot pretend to be the extension because Chrome enforces the allowed_origins via the chrome-extension:// origin. We cannot pipe stdio into this host from the VPS.
- No CLI flag exists in the manifest for "headless task execution." `Claude.exe` is a `Windows.FullTrustApplication` Electron host, expected to be GUI-driven.

**Browser session access: YES, but not for us.** Claude Desktop integrates with the Chrome extension via the native messaging stdio bridge. When the user opens the side panel in Chrome (Ctrl+E), the extension reads the page's accessibility tree, sends it via stdio to `chrome-native-host.exe`, which routes the agent loop through Claude Desktop and back. **This is a closed loop between Tate's Chrome and Tate's Claude Desktop.** EcodiaOS sits outside it.

**Verdict on Path 2: Eliminated.** Powerful agent for Tate's interactive use. Not driveable from our conductor.

### 9.2 Path 3: Claude for Chrome (extension fcoeoabgfenejglbffodgkkbkcdhcgfn, v1.0.69)

**Installed on Corazon: YES.** In Tate's Default Chrome profile (= code@ecodia.au workspace, the high-value profile with all his SaaS auth). Listed name: `Claude` ("Claude in Chrome (Beta)"). Manifest extracted verbatim.

**Manifest highlights (verbatim from `manifest.json`):**

- `host_permissions: ["<all_urls>"]` — can act on any page Tate is on.
- `permissions: [..., "debugger", "scripting", "tabs", "webNavigation", "nativeMessaging", "downloads", "identity", ...]` — full agent toolkit.
- Two content scripts injected on `<all_urls>`:
  - `accessibility-tree.js` (`run_at: document_start`, `all_frames: true`) — builds a structured accessibility tree of every page. **This is structurally richer than computer-use's screenshot-only signal.**
  - `agent-visual-indicator.js` (`run_at: document_idle`) — the floating UI that shows agent activity.
- `commands: { toggle-side-panel: { suggested_key: "Ctrl+E" } }` — human invocation hotkey.
- **`externally_connectable.matches: ["https://claude.ai/*", "https://*.claude.ai/*"]`** — only claude.ai web pages can `chrome.runtime.sendMessage` to the extension. The conductor (running on `api.admin.ecodia.au` on the VPS) is NOT in this allowlist and cannot extend it.

**Programmatic surface from a third-party server: NO.** We cannot:
1. Send extension messages directly (externally_connectable is claude.ai-only).
2. Use the native messaging bridge (gated by extension ID allowlist on the host side).
3. Authenticate as the user against any documented HTTP endpoint (none exists).

The closest indirect path: navigate Tate's Chrome to `claude.ai`, type instructions into the claude.ai chat that targets the extension. This works for Tate (it's the human path). For us, it would mean GUI-automating claude.ai — putting computer-use-shaped problems on top of computer-use-shaped problems.

**Browser session access: YES, but again not for us.** The extension is a beautiful match for "drive Tate's logged-in browser" — it IS that, by design — but we can't invoke it from outside.

**Verdict on Path 3: Eliminated for the same reason as Path 2.** It's exactly the agent we'd build, shipped by Anthropic, running in the right profile, with richer signal than computer-use — and locked behind a consumer-product invocation surface.

### 9.3 Path 1: Anthropic computer-use API (programmatic)

**Programmatic surface: YES.** Plain `messages.create` with the `computer_20251124` tool block over a standard API key. We control the loop. Full audit trail. Token cost predictable (~2.5-3k per iteration). Latency 3-6 s/iteration on Opus 4.7. See Sections 1-8 above for the full contract.

**Browser session access: INDIRECT.** The model sees screenshots from Corazon. Corazon is Tate's Default Chrome profile — so the model effectively operates *in* Tate's logged-in browser, just by virtue of the screenshot showing what Tate's Chrome shows. We don't get the accessibility-tree signal that the Chrome extension has, but we do get the same auth context.

**Verdict on Path 1: WINS BY DEFAULT** — not because it's the richest path, but because it's the only programmatically reachable one.

### 9.4 Comparison matrix

| Criterion | Path 1: API | Path 2: Claude Desktop | Path 3: Claude for Chrome |
|---|---|---|---|
| (a) Already on Corazon | n/a (server-side) | **Yes**, v1.1.6452.0 signed | **Yes**, ext v1.0.69 in Default profile |
| (b) Programmatic invocation from conductor | **Yes**, plain HTTPS | **No** (claude:// is deeplink only; cowork-svc not listening; native-host is stdio + allowlisted) | **No** (externally_connectable is claude.ai-only; native-host gated) |
| (c) Access to Tate's signed-in browser | Indirect via screenshot of Corazon's Chrome | Yes via the human side-panel loop (not us) | Yes via the human side-panel loop (not us) |
| (d) Cost per iteration | ~2.5-3k tokens (~$0.02-0.05 Opus 4.7) | $0 marginal (uses Tate's Max sub) | $0 marginal (uses Tate's Max sub) |
| (e) Latency per iteration | 3-6 s | n/a (not driveable) | n/a (not driveable) |
| (f) Signal richness | Screenshot only | Accessibility tree + screenshot via native-host | Accessibility tree + screenshot via DOM injection |
| (g) What we DELETE if we adopt it | vision.locate, runbook.run iterator, vision-proxy backend route, step/anchor/validation columns (≈1080 LOC) | Everything above + the 5 cu.* primitives (the agent becomes an end-to-end no-op for macros) — but only if we could invoke it | Same as Path 2 — but only if we could invoke it |

### 9.5 Recommendation

**Adopt Path 1 (Anthropic computer-use API). Do NOT attempt to integrate Path 2 or Path 3 as macro substrates.**

**Why this is the right answer despite Tate's "the tools already exist" framing:**

The tools exist for *Tate*. Claude Desktop + Claude for Chrome are best-in-class agent products for a human user driving them. The accessibility-tree signal in the Chrome extension is genuinely better than what computer-use sees. But Anthropic has deliberately kept these surfaces closed to third-party programmatic invocation — the native-messaging bridge is stdio-only, the extension's externally_connectable is claude.ai-only, the desktop's `cowork-svc` doesn't expose a public TCP port, and `claude://` is a deeplink not an RPC. **The "tool that already exists" for our use case (server-driven autonomous macros) is the computer-use API, not Desktop or Chrome.**

The corollary: the framing pivot Tate triggered is still right. We were building a parallel implementation (vision.locate proxy + step iterator) of a thing Anthropic already ships. The thing Anthropic ships **for our shape of use** is the computer-use beta API. Adopting it deletes ~1080 LOC of bespoke runtime, replaces it with ~860 LOC of thin executor + loop, and drops the maintenance burden of a homegrown vision system.

### 9.6 Three specific deletions that follow from picking Path 1

1. **Delete `tools/vision.js` on Corazon** (`D:\.code\eos-laptop-agent\tools\vision.js`, est. ~200 LOC) — the bespoke locate primitive becomes useless once the model is processing screenshots end-to-end. This is the single biggest doctrine + code simplification.

2. **Delete the backend vision proxy route** (`src/routes/laptopVision.js`, est. ~80 LOC, plus its service). The conductor talks to `api.anthropic.com/v1/messages` directly with the computer-use tool block. No proxy needed.

3. **Drop the `steps`, `vision_targets`, `validations` columns from `macro_runbooks` and replace with `brief` + `inputs_schema`** (schema migration in §4). This is the data-model deletion that codifies the runtime change. After backfill to `legacy_*` columns and a one-week observation window, drop the legacy columns too.

### 9.7 Hybrid option (rejected, documented for record)

Could we GUI-automate Claude for Chrome by typing into Ctrl+E side panel and screen-scraping the result? Mechanically yes — Corazon already drives Chrome via `input.*`. But:

- "Wait for the agent's task to complete" is unobservable to us; the side panel's success-state lives inside the extension's UI.
- We'd lose `abort.check` (no kill switch into the side panel).
- We'd lose `question.surface` (the extension's question-surface lives inside its UI, not our control loop).
- We'd lose structured action logs (the extension keeps its own trace, not exposed externally).
- We'd be GUI-automating an agent in order to escape GUI automation. Circular.

**Rejected.** Path 1 wins cleanly.

### 9.8 What this means for Tate's existing Claude for Chrome usage

Path 3 being "rejected as a macro substrate" does NOT mean Tate should uninstall Claude for Chrome. The extension is independently valuable for Tate's interactive work — Ctrl+E, "summarise this PR", "fill out this form", "find the conflict in this thread" — and it operates in Tate's logged-in profile where the conductor cannot. Keep both:

- **Conductor's automated macros** → computer-use API + Corazon's `cu.*` executor.
- **Tate's interactive ad-hoc agent help** → Claude for Chrome side panel.

The two paths coexist. The pivot is only about which substrate the *codified, server-driven* macro runtime sits on top of.

---

**End of spec. fork_mojvsm49_8087ec — scoping only, no code changed, no DB changed, no agent restarts, no doctrine files modified. Decision is Tate's.**
