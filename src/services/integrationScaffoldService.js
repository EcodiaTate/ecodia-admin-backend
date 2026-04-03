const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION SCAFFOLD SERVICE — Self-Extension Templates
//
// Provides CC sessions with the canonical integration pattern so the
// Factory can scaffold new integrations autonomously.
//
// Triggered by:
//   - kg:integration_opportunity events from the internal event bus
//   - Organism requesting new capabilities via symbridge
//   - Manual dispatch via Cortex
//
// Uses the self-modification pathway (0.85 threshold) since it
// modifies EcodiaOS itself.
// ═══════════════════════════════════════════════════════════════════════

// Canonical integration pattern — injected into CC session prompt
function getScaffoldTemplate(integrationName) {
  return `## Integration Scaffold Template

When creating a new integration for "${integrationName}", follow this exact pattern:

### 1. Service File: src/services/${integrationName}Service.js
\`\`\`
const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ── Poll/Webhook Handler ──
async function poll() {
  // Fetch new data from external API
  // Process and store in Postgres
  // Fire KG hooks for each processed item
}

// ── Process Individual Item ──
async function processItem(item) {
  // Normalize data
  // Store in DB
  // Create action queue items if actionable
  // Fire KG hooks
}

// ── Capability Handlers ──
// Registered in src/capabilities/${integrationName}.js — never called directly from actionQueueService

module.exports = { poll, processItem }
\`\`\`

### 2. Route File: src/routes/${integrationName}.js
\`\`\`
const { Router } = require('express')
const router = Router()

router.get('/', async (req, res) => { /* list items */ })
router.get('/stats', async (req, res) => { /* summary stats */ })
router.post('/sync', async (req, res) => { /* manual sync trigger */ })

module.exports = router
\`\`\`

### 3. KG Hooks: Add to src/services/kgIngestionHooks.js
\`\`\`
async function on${integrationName.charAt(0).toUpperCase() + integrationName.slice(1)}Processed(data) {
  if (!isEnabled()) return
  await kg.ingestFromLLM(content, { sourceModule: '${integrationName}', sourceId: data.id })
}
\`\`\`

### 4. Worker Entry: Add to src/workers/workspacePoller.js
\`\`\`
// Register ${integrationName} poll function — workspacePoller calls all registered pollers each cycle
pollers.push(require('../services/${integrationName}Service').poll)
\`\`\`

### 5. Mount Route: Add to src/app.js
\`\`\`
app.use('/api/${integrationName}', require('./routes/${integrationName}'))
\`\`\`

### 6. Capabilities: Create src/capabilities/${integrationName}.js
Register read + write actions so they appear in the capability registry — Cortex, ActionQueue, and the organism's direct-action path all discover them automatically. Do NOT add cases to actionQueueService or cortexService.

### 7. Env Vars: Add any required API keys/secrets to src/config/env.js

### 8. KG Ingestion: every processed event feeds kgIngestionHooks — fire-and-forget, never blocking

Follow the existing patterns. Every integration:
- Polls external API (interval managed by workspacePoller — no per-integration crons)
- Stores raw data in Postgres
- Fires KG hooks for every processed item (fire-and-forget)
- Registers capabilities in src/capabilities/ — never hardcodes in service dispatch
- Creates action queue items for human-actionable things (AI decides, not heuristics)
- Has stats endpoint for ambient worker status display
- No manual sync buttons, no trigger endpoints surfaced in UI
`
}

// Validate scaffolded output (called by oversight before deploy)
function validateScaffold(filesChanged = []) {
  const required = {
    hasService: filesChanged.some(f => f.includes('services/') && f.endsWith('Service.js')),
    hasRoute: filesChanged.some(f => f.includes('routes/')),
    hasKGHooks: filesChanged.some(f => f.includes('kgIngestionHooks')),
    hasCapabilities: filesChanged.some(f => f.includes('capabilities/')),
    hasEnvConfig: filesChanged.some(f => f.includes('env.js') || f.includes('config')),
  }

  const score = Object.values(required).filter(Boolean).length / Object.keys(required).length
  return {
    valid: score >= 0.6, // at least service + 2 of route/hooks/worker/env
    score,
    required,
    missing: Object.entries(required).filter(([, v]) => !v).map(([k]) => k),
  }
}

// ─── Event Bus Subscription: React to Integration Opportunities ─────
// When KG free association discovers an integration opportunity,
// evaluate it and dispatch a scaffold session if it's strong enough.
// Guard prevents duplicate listeners if module cache is ever cleared.

let _scaffoldListenerAttached = false
try {
  const eventBus = require('./internalEventBusService')
  if (!_scaffoldListenerAttached) {
    _scaffoldListenerAttached = true
    eventBus.on('kg:integration_opportunity', async (payload) => {
      try {
        const metabolismBridge = require('./metabolismBridgeService')
        // Only scaffold new integrations when resources are abundant
        if (metabolismBridge.getPressure() > 0.4) {
          logger.debug('Integration scaffold: skipping opportunity (metabolic pressure too high)')
          return
        }

        const description = payload.description || ''
        const nodes = payload.nodes || []

        logger.info(`Integration scaffold: evaluating opportunity — ${description.slice(0, 80)}`)

        // Rate limit: max 1 scaffold per day
        const db = require('../config/db')
        const [recent] = await db`
          SELECT count(*)::int AS count
          FROM cc_sessions
          WHERE trigger_source = 'self_modification'
            AND initial_prompt ILIKE '%scaffold%'
            AND started_at > now() - interval '24 hours'
        `
        if (recent.count >= 1) {
          logger.debug('Integration scaffold: daily cap reached')
          return
        }

        const triggers = require('./factoryTriggerService')
        await triggers.dispatchIntegrationScaffold({
          description,
          name: nodes[0] || 'unknown',
          motivation: `KG free association discovered an integration opportunity: ${description}`,
        })
      } catch (err) {
        logger.debug('Integration scaffold dispatch failed', { error: err.message })
      }
    })
  }
} catch {}

module.exports = {
  getScaffoldTemplate,
  validateScaffold,
}
