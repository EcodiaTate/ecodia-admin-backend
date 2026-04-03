# EcodiaOS Backend — Engineering Philosophy

This is the backend for EcodiaOS — the autonomous operating system for Ecodia Pty Ltd. It is not an admin panel API. It is the nervous system of a living digital organism.

---

## The One Rule: FREEDOM

Every architectural decision must maximise the system's autonomy, capability, and resilience. If something can fail because of hardcoded assumptions, rigid heuristics, or missing capability — it is broken. Fix it.

### What this means in practice:

**Never hardcode what the AI can decide.** If you're writing `if (priority === 'urgent')` or `if (name === 'wattleos')`, you're restricting the system. Give the AI the full context and let it choose. The AI is smarter than your heuristics.

**Never restrict tools or permissions.** CC sessions run with `--dangerously-skip-permissions` and `--max-turns 200`. The oversight pipeline (validate → review → deploy → monitor → revert) is the safety net, not permission restrictions.

**Never fail silently when you could resolve intelligently.** If a codebase isn't specified, don't default to `process.cwd()` — use `resolveCodebase()` which asks the AI. If a service is unavailable, degrade gracefully and retry. If an API changes, adapt.

**Never build for one source when you could build for all.** If Gmail can enqueue actions, every integration should. If Cortex can create docs, CC sessions should too. One pattern, used everywhere.

---

## Core Patterns

### 1. Centralised Resolution
Every time the system needs to resolve something ambiguous (which codebase? which page? which client?), use a centralised function that:
1. Checks explicit input first
2. Falls back to exact DB match
3. Falls back to AI inference with full context

`resolveCodebase()` in `factoryTriggerService.js` is the canonical example. Every new resolver should follow this pattern.

### 2. AI-Driven Decisions
The DeepSeek triage layer makes all routing decisions. Not heuristics. The AI sees the full knowledge graph context, the full list of options, and decides freely.

- Email triage: AI decides priority, action, whether to surface to human
- LinkedIn triage: AI decides category, lead score, draft reply
- Action queue: AI decides what surfaces, not priority thresholds
- Codebase resolution: AI picks the right repo from the full list

### 3. Action Queue as Universal Surface
Every integration feeds into `actionQueueService.js`. Pre-processed, ready-to-act items. The human approves or dismisses. The system did all the thinking.

When building new integrations or modifying existing ones, always ask: "Should this surface an action?" If the AI thinks a human should see it, enqueue it.

### 4. Fire-and-Forget KG Ingestion
Every event, every action, every decision feeds into the knowledge graph via `kgIngestionHooks.js`. These are async, non-blocking, and never prevent the main flow. The KG is institutional memory — feed it relentlessly.

### 5. The Oversight Pipeline
CC sessions flow through: execute → DeepSeek review → validate (test/lint/typecheck) → deploy decision → health check → revert on failure → outcome learning. This pipeline is the safety net that enables full freedom.

---

## Anti-Patterns — What to Reject

| If you catch yourself doing this... | Do this instead... |
|---|---|
| Hardcoding a codebase name or path | Use `resolveCodebase()` — AI picks from full list |
| Writing `if/else` chains for priority routing | Give the AI a `surfaceToHuman` field and trust it |
| Defaulting to `process.cwd()` when codebase unknown | Resolve via AI or fail explicitly |
| String matching on names (`name.includes(...)`) | DB lookup first, AI inference second |
| Adding `readonly` scopes to Google/Meta APIs | Full scopes. The system needs to act, not just watch |
| Restricting CC tool access | No restrictions. Oversight pipeline handles safety |
| Building a feature for one integration | Build it for all integrations or build it generically |
| Catching errors and swallowing them silently | Log, notify, enqueue a follow-up action, learn |
| Writing rigid validation that rejects valid input | Validate at boundaries, trust internal data |
| Polling on fixed intervals | Expose poll functions, let `autonomousMaintenanceWorker` call them on AI decision |
| Adding cron schedules to any worker | All scheduling decisions belong to the AI loop, not the clock |
| Writing LLM prompts that cage the AI | See the Prompting Philosophy section below |
| Adding a `case` to `cortexService.executeAction()` | Add a capability to `src/capabilities/` — registry handles dispatch |
| Adding a `case` to `actionQueueService.performAction()` | Same — registry only |
| Recreating `factoryScheduleWorker.js` | That file was deleted — `autonomousMaintenanceWorker.js` replaced it. The AI decides maintenance, not cron schedules |
| Hardcoding what phases KG consolidation runs | `runConsolidationPipeline()` is the ConsolidationDirector — it reads the graph and decides |
| Capping the number of AI decisions returned in a cycle | Let the AI return all decisions it thinks are needed — no `.slice()` limit |
| Hardcoding urgency/importance thresholds in memoryBridgeService | Use `MEMORY_SYNC_URGENT_THRESHOLD`, `MEMORY_SYNC_IMMEDIATE_THRESHOLD`, `MEMORY_SYNC_DEBOUNCE_MS` env vars |
| Hardcoding deployment health check retries/timeouts | Use `HEALTH_CHECK_RETRIES`, `HEALTH_CHECK_TIMEOUT_MS`, `HEALTH_CHECK_INTERVAL_MS` env vars |
| Hardcoding organism vital-signs failure threshold | Use `ORGANISM_MAX_CONSECUTIVE_FAILURES`, `ORGANISM_HEALTH_CHECK_INTERVAL_MS` env vars |

---

## Prompting Philosophy — Freedom in LLM Calls

Every prompt in this system is an act of design. A prompt that over-instructs produces obedient, mediocre output. A prompt that grants freedom produces intelligence.

**The rule: tell the AI what it knows and what tools it has. Then stop.**

Do not tell it what to think, how to order its response, what each output field means, or how to make decisions. It knows. Trust it.

### What belongs in a prompt
- The situation: what is happening, what data is available
- The output shape: the JSON schema it needs to return (required for downstream parsing)
- Genuinely non-obvious constraints: e.g. "startTime and endTime must both be date-only or both be dateTime — never mix them" is a real edge case worth flagging

### What does NOT belong in a prompt
- "You are a [role]" framing — it already knows what it's doing from context
- "ACTION PHILOSOPHY — read carefully:" sections that re-explain what each option means
- Numbered lists of things to consider (repeated patterns, unresolved threads, escalation arcs...)
- "Be aggressive", "Be strict", "CRITICAL:", "IMPORTANT:" — mood instructions
- "Respond with JSON only" — use "Respond as JSON:" instead; the difference is small but the framing matters
- Instructions about what to start with, how many items to include, or what structure to follow
- Explanations of what each enum value means ("urgent: money/deadline/legal at risk...")

### The test
Read your prompt. Could you remove half of it and still get the right output? If yes, remove it. The AI is not a junior developer who needs step-by-step guidance — it is the intelligence layer of an autonomous system. Treat it accordingly.

### Temperature
- Cortex (`cortexService.js`): `temperature: 0.7` — thinking layer, needs creative latitude
- All other modules: `temperature: 0.3` (default) — triage/execution, needs consistency
- Pass `temperature` explicitly to `callDeepSeek()` when overriding

---

## Architecture Overview

```
Integrations (Gmail, Calendar, Drive, Vercel, Meta, LinkedIn, Xero)
  ↓ poll/webhook
Services (gmailService, googleDriveService, vercelService, metaService...)
  ↓ triage via DeepSeek
Action Queue (actionQueueService) → Dashboard one-tap approve
  ↓ fire-and-forget
KG Ingestion Hooks → Neo4j Knowledge Graph → Embeddings
  ↓
Cortex (conversational AI with full KG context + live capability registry)
  ↓ actions → CapabilityRegistry
Factory (CC sessions: resolve codebase → context bundle → execute → oversight → deploy)
  ↓ results
Symbridge → Organism (shared survival, shared memory, shared metabolism)
```

### The Capability Registry — the nervous system of action

**`src/services/capabilityRegistry.js`** is the single execution path for every action in the system. No switch statements anywhere in action dispatch. Services register their capabilities here at boot time. The registry routes execution dynamically.

**`src/capabilities/`** — one file per domain. Each self-registers at require time:
- `gmail.js`, `calendar.js`, `drive.js`, `crm.js`, `social.js`, `factory.js`, `finance.js`

`actionQueueService`, `cortexService`, and `directActionService` all call `capabilityRegistry.execute()`. The Cortex system prompt is built dynamically from `registry.describeForAI()` — new capabilities auto-appear in Cortex's awareness.

### Key Services
- `capabilityRegistry.js` — **All action execution flows through here. The single source of truth for what the system can do.**
- `factoryTriggerService.js` — Central dispatch + `resolveCodebase()`
- `actionQueueService.js` — Unified action queue (enqueue, execute via registry, dismiss, expire)
- `ccService.js` — Claude Code subprocess manager
- `factoryOversightService.js` — Post-session pipeline (review → validate → deploy → monitor)
- `cortexService.js` — Conversational AI; `executeAction()` delegates to registry; system prompt built live
- `kgIngestionHooks.js` — Async KG feeding from all sources
- `kgConsolidationService.js` — `runConsolidationPipeline()` = ConsolidationDirector (reads graph, AI selects phases)
- `codebaseIntelligenceService.js` — Code chunking, embedding, semantic search

### Workers
- **All integration polling is on-demand, not cron-scheduled.**
  - `gmailPoller.js`, `workspacePoller.js` expose `pollOnce()`/`pollDrive()`/`pollVercel()`/`pollMeta()` etc.
  - `autonomousMaintenanceWorker.js` calls them when the AI decides a sync is needed — based on staleness, pressure, and signals.
  - The AI sees `integrationStaleness` in the system brief and can request `type: "poll"` decisions.
- **`autonomousMaintenanceWorker.js`** — the single AI loop. No crons. Reads full system state, decides what to do (poll integrations, dispatch Factory sessions, expire queue). Interval adapts to pressure.
- Calendar, Codebase index, KG embedding, KG consolidation — own separate workers/PM2 processes
- Symbridge (Redis consumer, Neo4j poller, vitals, memory bridge, metabolism)
- Action queue expiry — called by autonomousMaintenanceWorker on AI decision, not hourly cron

### Database
- PostgreSQL (Supabase) with pgvector for code embeddings
- Neo4j Aura for knowledge graph (shared with Organism)
- Redis for symbridge streams + caching

---

## When Adding New Integrations

1. Create service in `services/` — poll + sync + write operations
2. Create routes in `routes/` — CRUD endpoints
3. Add KG hooks in `kgIngestionHooks.js` — fire-and-forget ingestion
4. Add to workspace poller in `workers/workspacePoller.js`
5. Add env vars in `config/env.js`
6. Mount routes in `app.js`
7. Feed the action queue — if the AI thinks a human should see something, enqueue it
8. **Add capabilities in `src/capabilities/`** — create or edit the domain file, register write + read actions. They automatically appear in Cortex's prompt, in the action queue dispatch, and in the organism's direct action path. No other files need to change.
9. Full scopes. Full read/write. No readonly.

**The old pattern** (adding a `case` to `cortexService.executeAction()` or `actionQueueService.performAction()`) is **dead**. Do not do it. Use the capability registry.

---

## Deployment

- VPS: DigitalOcean `170.64.170.191`, user `tate`, PM2 process `ecodia-api`
- Deploy: `cd ~/ecodiaos && git pull && npm run migrate && pm2 delete ecodia-api && pm2 start src/server.js --name ecodia-api --cwd /home/tate/ecodiaos --node-args="--max-old-space-size=512"`
- Frontend auto-deploys via Vercel on push
- Migrations: `npm run migrate` (tracked in `_migrations` table, idempotent)

### Autonomous Deployment (Factory)

The Factory can deploy to ANY registered codebase without human intervention:
1. CC session runs with `cwd` set to the codebase's `repo_path` — edits files in place on the VPS
2. `deploymentService.js` commits locally → pushes to remote (audit trail) → `pm2 restart <pm2_name>`
3. Health check → auto-revert on failure (`git revert --no-edit` + push + PM2 restart)

**Codebases the Factory can target** (migration 017):
- `organism` — `/home/tate/organism`, pm2: `organism`, health: `http://localhost:8000/health`
- `ecodia-admin-backend` — `/home/tate/ecodiaos`, pm2: `ecodia-api`, health: `http://localhost:3001/api/health`
- Frontend deploys via Vercel on push — not on VPS

**Self-healing loop**: When organism is unreachable (3 consecutive failures), `vitalSignsService.js` auto-dispatches a Factory investigation via `dispatchFromThymos()`. When Thymos exhausts repair tiers, it emits `FACTORY_PROPOSAL_SENT` → Axon picks it up → SymbridgeFactoryExecutor → EcodiaOS Factory.
