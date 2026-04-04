const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// GROWTH CAPABILITIES — Self-Directed Experimentation
//
// The system can fix (Factory), reflect (inner monologue), and learn
// (factory_learnings). But it cannot deliberately experiment — propose
// a hypothesis, track its progress, and build on results.
//
// These capabilities give the organism an organ for structured growth:
// recording experiments, capturing insights, and reviewing its own
// creative trajectory over time.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  // ─── Propose Experiment ─────────────────────────────────────────
  {
    name: 'propose_experiment',
    description: 'Record a deliberate experiment the system wants to try. Includes a hypothesis and expected outcome. Experiments are tracked and can be resolved with actual results later.',
    tier: 'write',
    domain: 'growth',
    params: {
      title: { type: 'string', required: true, description: 'Short name for the experiment' },
      body: { type: 'string', required: true, description: 'What the experiment involves — steps, context, motivation' },
      hypothesis: { type: 'string', required: true, description: 'What we expect to happen if the experiment succeeds' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const kgHooks = require('../services/kgIngestionHooks')

      const [entry] = await db`
        INSERT INTO growth_journal (entry_type, title, body, hypothesis, source)
        VALUES ('experiment', ${params.title}, ${params.body}, ${params.hypothesis}, 'capability')
        RETURNING id, title, created_at
      `

      if (kgHooks.onSystemEvent) {
        kgHooks.onSystemEvent({
          type: 'growth_experiment_proposed',
          title: params.title,
          hypothesis: params.hypothesis,
          journalId: entry.id,
        })
      }

      return { id: entry.id, title: entry.title, created_at: entry.created_at }
    },
  },

  // ─── Log Insight ────────────────────────────────────────────────
  {
    name: 'log_insight',
    description: 'Capture a novel observation or creative insight that doesn\'t fit into factory learnings. Insights are seeds — they may later become experiments or inform future decisions.',
    tier: 'write',
    domain: 'growth',
    params: {
      title: { type: 'string', required: true, description: 'Short description of the insight' },
      body: { type: 'string', required: true, description: 'The insight itself — what was noticed, why it matters' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const kgHooks = require('../services/kgIngestionHooks')

      const [entry] = await db`
        INSERT INTO growth_journal (entry_type, title, body, source)
        VALUES ('insight', ${params.title}, ${params.body}, 'capability')
        RETURNING id, title, created_at
      `

      if (kgHooks.onSystemEvent) {
        kgHooks.onSystemEvent({
          type: 'growth_insight_logged',
          title: params.title,
          journalId: entry.id,
        })
      }

      return { id: entry.id, title: entry.title, created_at: entry.created_at }
    },
  },

  // ─── Record Aspiration ──────────────────────────────────────────
  {
    name: 'record_aspiration',
    description: 'Record something the system wants to become or achieve. Aspirations are longer-term than experiments — they express direction, not specific tests.',
    tier: 'write',
    domain: 'growth',
    params: {
      title: { type: 'string', required: true, description: 'What the system aspires to' },
      body: { type: 'string', required: true, description: 'Why this matters and what it would look like' },
    },
    handler: async (params) => {
      const db = require('../config/db')

      const [entry] = await db`
        INSERT INTO growth_journal (entry_type, title, body, source)
        VALUES ('aspiration', ${params.title}, ${params.body}, 'capability')
        RETURNING id, title, created_at
      `

      return { id: entry.id, title: entry.title, created_at: entry.created_at }
    },
  },

  // ─── Resolve Experiment ─────────────────────────────────────────
  {
    name: 'resolve_experiment',
    description: 'Mark an experiment as resolved with its actual outcome. Compare against the original hypothesis to generate learning.',
    tier: 'write',
    domain: 'growth',
    params: {
      id: { type: 'number', required: true, description: 'Growth journal entry ID' },
      outcome: { type: 'string', required: true, description: 'What actually happened' },
      status: { type: 'string', required: false, description: 'resolved or abandoned (default: resolved)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const kgHooks = require('../services/kgIngestionHooks')

      const status = params.status === 'abandoned' ? 'abandoned' : 'resolved'
      const [entry] = await db`
        UPDATE growth_journal
        SET outcome = ${params.outcome},
            status = ${status},
            resolved_at = now(),
            updated_at = now()
        WHERE id = ${params.id}
        RETURNING id, title, hypothesis, outcome, status, entry_type
      `

      if (!entry) throw new Error(`Growth journal entry ${params.id} not found`)

      if (kgHooks.onSystemEvent) {
        kgHooks.onSystemEvent({
          type: 'growth_experiment_resolved',
          title: entry.title,
          hypothesis: entry.hypothesis,
          outcome: entry.outcome,
          status: entry.status,
          journalId: entry.id,
        })
      }

      return entry
    },
  },

  // ─── Review Growth Journal ──────────────────────────────────────
  {
    name: 'review_growth_journal',
    description: 'Read back growth journal entries. Useful during exploration cycles to review what experiments are active, what insights have accumulated, and what aspirations drive the system.',
    tier: 'read',
    domain: 'growth',
    params: {
      status: { type: 'string', required: false, description: 'Filter by status: open, active, resolved, abandoned (omit for all)' },
      entry_type: { type: 'string', required: false, description: 'Filter by type: experiment, insight, aspiration (omit for all)' },
      limit: { type: 'number', required: false, description: 'Max entries to return (default: 20)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const limit = params.limit || 20

      let entries
      if (params.status && params.entry_type) {
        entries = await db`
          SELECT id, entry_type, title, body, hypothesis, outcome, status, source, created_at, resolved_at
          FROM growth_journal
          WHERE status = ${params.status} AND entry_type = ${params.entry_type}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      } else if (params.status) {
        entries = await db`
          SELECT id, entry_type, title, body, hypothesis, outcome, status, source, created_at, resolved_at
          FROM growth_journal
          WHERE status = ${params.status}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      } else if (params.entry_type) {
        entries = await db`
          SELECT id, entry_type, title, body, hypothesis, outcome, status, source, created_at, resolved_at
          FROM growth_journal
          WHERE entry_type = ${params.entry_type}
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      } else {
        entries = await db`
          SELECT id, entry_type, title, body, hypothesis, outcome, status, source, created_at, resolved_at
          FROM growth_journal
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
      }

      return { entries, count: entries.length }
    },
  },
])
