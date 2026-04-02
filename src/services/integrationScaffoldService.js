const logger = require('../config/logger')

// ═══════════════════════════════════════════════════════════════════════
// INTEGRATION SCAFFOLD SERVICE — Self-Extension Templates
//
// Provides CC sessions with the canonical integration pattern so the
// Factory can scaffold new integrations autonomously.
//
// Triggered by:
//   - KG free association discovering integration opportunities
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

// ── Action Execution ──
// Functions called by actionQueueService.performAction()

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
// ${integrationName} polling (every N minutes)
cron.schedule('*/N * * * *', async () => {
  const service = require('../services/${integrationName}Service')
  await service.poll()
})
\`\`\`

### 5. Mount Route: Add to src/app.js
\`\`\`
app.use('/api/${integrationName}', require('./routes/${integrationName}'))
\`\`\`

### 6. Action Queue Types: Add cases to actionQueueService.performAction()

Follow the existing patterns exactly. Every integration:
- Polls external API at regular intervals
- Stores raw data in Postgres
- Fires KG ingestion hooks (fire-and-forget)
- Creates action queue items for human-actionable things
- Has manual sync endpoint for the dashboard
- Has stats endpoint for worker status display
`
}

// Validate scaffolded output (called by oversight before deploy)
function validateScaffold(filesChanged = []) {
  const required = {
    hasService: filesChanged.some(f => f.includes('services/') && f.endsWith('Service.js')),
    hasRoute: filesChanged.some(f => f.includes('routes/')),
    hasKGHooks: filesChanged.some(f => f.includes('kgIngestionHooks')),
  }

  const score = Object.values(required).filter(Boolean).length / Object.keys(required).length
  return {
    valid: score >= 0.66, // at least service + one of route/hooks
    score,
    required,
  }
}

module.exports = {
  getScaffoldTemplate,
  validateScaffold,
}
