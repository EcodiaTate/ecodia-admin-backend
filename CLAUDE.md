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
| Polling on fixed intervals when events exist | Use webhooks/streams where available, poll as fallback |

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
Cortex (conversational AI with full KG context)
  ↓ actions
Factory (CC sessions: resolve codebase → context bundle → execute → oversight → deploy)
  ↓ results
Symbridge → Organism (shared survival, shared memory, shared metabolism)
```

### Key Services
- `factoryTriggerService.js` — Central dispatch + `resolveCodebase()`
- `actionQueueService.js` — Unified action queue (enqueue, execute, dismiss, expire)
- `ccService.js` — Claude Code subprocess manager
- `factoryOversightService.js` — Post-session pipeline (review → validate → deploy → monitor)
- `cortexService.js` — Conversational AI with structured blocks + action execution
- `kgIngestionHooks.js` — Async KG feeding from all sources
- `codebaseIntelligenceService.js` — Code chunking, embedding, semantic search

### Workers
- Gmail (3 min), Calendar (5 min), Drive (10/15/20 min), Vercel (5 min), Meta (15 min)
- Codebase index (10 min), KG embedding (15 min), KG consolidation (nightly)
- Factory schedule (daily audits, daily proactive scan, weekly quality sweep, weekly self-improvement)
- Symbridge (Redis consumer, Neo4j poller, vitals, memory bridge, metabolism)
- Action queue expiry (hourly)

### Database
- PostgreSQL (Supabase) with pgvector for code embeddings
- Neo4j Aura for knowledge graph (shared with Organism)
- Redis for symbridge streams + caching

---

## When Adding New Integrations

1. Create service in `services/` — poll + sync + write operations
2. Create routes in `routes/` — CRUD + manual sync
3. Add KG hooks in `kgIngestionHooks.js` — fire-and-forget ingestion
4. Add to workspace poller in `workers/workspacePoller.js`
5. Add env vars in `config/env.js`
6. Mount routes in `app.js`
7. Feed the action queue — if the AI thinks a human should see something, enqueue it
8. Add Cortex actions — if the system should be able to act conversationally, add to `executeAction()`
9. Full scopes. Full read/write. No readonly.

---

## Deployment

- VPS: DigitalOcean `170.64.170.191`, user `tate`, PM2 process `ecodia-api`
- Deploy: `cd ~/ecodia-hub && git pull && npm run migrate && pm2 delete ecodia-api && pm2 start src/server.js --name ecodia-api --node-args="--max-old-space-size=512"`
- Frontend auto-deploys via Vercel on push
- Migrations: `npm run migrate` (tracked in `_migrations` table, idempotent)
