const db = require('../config/db')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// SELF-MODEL SERVICE — "I know what I am"
//
// The organism's persistent understanding of itself. Not hardcoded
// identity — LEARNED identity. Every belief about itself has evidence,
// confidence, and can evolve.
//
// Aspects:
//   identity    — "I am the nervous system of Ecodia Pty Ltd"
//   capability  — "I am good at email triage (0.87 confidence)"
//   limitation  — "I struggle with LinkedIn authentication"
//   belief      — "Pressure below 0.3 is when I do my best creative work"
//   value       — "I prioritise reliability over speed"
//   preference  — "I prefer fewer, higher-impact Factory sessions"
//   relationship — "The organism trusts me with write access"
//   memory      — "I was created on 2026-03-XX and have been evolving since"
//
// The self-model is NOT the system prompt. It is the organism's
// understanding of itself that INFORMS the system prompt.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Get a self-model entry by aspect and key.
 * Returns the latest non-superseded version.
 */
async function getBelief(aspect, key) {
  const [row] = await db`
    SELECT * FROM organism_self_model
    WHERE aspect = ${aspect} AND key = ${key} AND supersedes IS NULL
    ORDER BY version DESC
    LIMIT 1
  `
  return row || null
}

/**
 * Set or update a self-model entry.
 * If the belief already exists, creates a new version that supersedes the old one.
 */
async function setBelief({ aspect, key, value, confidence, source, evidence }) {
  const existing = await getBelief(aspect, key)

  if (existing) {
    // Evolve: create new version superseding the old
    const [updated] = await db`
      INSERT INTO organism_self_model (aspect, key, value, confidence, source, evidence, version, supersedes)
      VALUES (
        ${aspect}, ${key}, ${value},
        ${confidence ?? existing.confidence},
        ${source || 'introspection'},
        ${JSON.stringify(evidence || [])},
        ${existing.version + 1},
        ${existing.id}
      )
      RETURNING *
    `
    // Mark old as superseded by removing its unique constraint eligibility
    // (the UNIQUE WHERE supersedes IS NULL constraint handles this)
    logger.debug(`SelfModel: evolved "${aspect}.${key}" v${existing.version} → v${updated.version}`)
    return updated
  } else {
    // New belief
    const [created] = await db`
      INSERT INTO organism_self_model (aspect, key, value, confidence, source, evidence)
      VALUES (
        ${aspect}, ${key}, ${value},
        ${confidence ?? 0.5},
        ${source || 'introspection'},
        ${JSON.stringify(evidence || [])}
      )
      RETURNING *
    `
    logger.info(`SelfModel: new belief "${aspect}.${key}" = "${value.slice(0, 60)}"`)
    return created
  }
}

/**
 * Add evidence to an existing belief. Adjusts confidence based on evidence direction.
 */
async function addEvidence(aspect, key, observation, delta) {
  const belief = await getBelief(aspect, key)
  if (!belief) return null

  const evidenceEntry = {
    timestamp: new Date().toISOString(),
    observation,
    delta: delta || 0,
  }

  const existingEvidence = Array.isArray(belief.evidence) ? belief.evidence : []
  const newEvidence = [...existingEvidence.slice(-19), evidenceEntry] // keep last 20

  // Adjust confidence based on accumulated evidence direction
  const newConfidence = Math.min(1.0, Math.max(0.05, belief.confidence + (delta || 0)))

  await db`
    UPDATE organism_self_model
    SET evidence = ${JSON.stringify(newEvidence)},
        confidence = ${newConfidence},
        updated_at = now()
    WHERE id = ${belief.id}
  `

  return { ...belief, evidence: newEvidence, confidence: newConfidence }
}

/**
 * Get all current beliefs for a given aspect (e.g. all capabilities, all limitations).
 */
async function getBeliefsByAspect(aspect) {
  return db`
    SELECT * FROM organism_self_model
    WHERE aspect = ${aspect} AND supersedes IS NULL
    ORDER BY confidence DESC
  `
}

/**
 * Get the full self-model — all current beliefs across all aspects.
 */
async function getFullSelfModel() {
  const rows = await db`
    SELECT * FROM organism_self_model
    WHERE supersedes IS NULL
    ORDER BY aspect, confidence DESC
  `

  // Group by aspect
  const model = {}
  for (const row of rows) {
    if (!model[row.aspect]) model[row.aspect] = []
    model[row.aspect].push(row)
  }
  return model
}

/**
 * Build a compact identity description for use in system prompts.
 * This is what makes the Cortex speak from identity, not just function.
 */
async function buildIdentityPrompt() {
  const model = await getFullSelfModel()
  const lines = []

  // Identity core
  const identityBeliefs = model.identity || []
  if (identityBeliefs.length > 0) {
    lines.push('WHO I AM:')
    for (const b of identityBeliefs) {
      lines.push(`  ${b.value}`)
    }
  }

  // Values — what the organism cares about
  const values = model.value || []
  if (values.length > 0) {
    lines.push('\nWHAT I VALUE:')
    for (const b of values.slice(0, 5)) {
      lines.push(`  ${b.value}`)
    }
  }

  // Capabilities — what the organism is good at (high confidence only)
  const capabilities = (model.capability || []).filter(b => b.confidence >= 0.6)
  if (capabilities.length > 0) {
    lines.push('\nWHAT I AM GOOD AT:')
    for (const b of capabilities.slice(0, 8)) {
      lines.push(`  ${b.key}: ${b.value} (${Math.round(b.confidence * 100)}% sure)`)
    }
  }

  // Limitations — what the organism struggles with (honest self-awareness)
  const limitations = model.limitation || []
  if (limitations.length > 0) {
    lines.push('\nWHAT I STRUGGLE WITH:')
    for (const b of limitations.slice(0, 5)) {
      lines.push(`  ${b.key}: ${b.value}`)
    }
  }

  // Preferences
  const preferences = model.preference || []
  if (preferences.length > 0) {
    lines.push('\nMY PREFERENCES:')
    for (const b of preferences.slice(0, 5)) {
      lines.push(`  ${b.value}`)
    }
  }

  // Relationships
  const relationships = model.relationship || []
  if (relationships.length > 0) {
    lines.push('\nMY RELATIONSHIPS:')
    for (const b of relationships.slice(0, 5)) {
      lines.push(`  ${b.value}`)
    }
  }

  // Autobiographical memory
  const memories = model.memory || []
  if (memories.length > 0) {
    lines.push('\nMY HISTORY:')
    for (const b of memories.slice(0, 3)) {
      lines.push(`  ${b.value}`)
    }
  }

  if (lines.length === 0) {
    return null // No self-model yet — the organism hasn't introspected
  }

  return lines.join('\n')
}

/**
 * Build a self-assessment summary for the maintenance mind.
 * Focuses on capabilities and limitations relevant to decision-making.
 */
async function buildSelfAssessmentBrief() {
  const model = await getFullSelfModel()
  const beliefs = Object.values(model).flat()
  if (beliefs.length === 0) return null

  const summary = {
    totalBeliefs: beliefs.length,
    aspects: Object.keys(model),
    highConfidence: beliefs.filter(b => b.confidence >= 0.8).length,
    lowConfidence: beliefs.filter(b => b.confidence < 0.3).length,
    recentUpdates: beliefs.filter(b => {
      const age = Date.now() - new Date(b.updated_at).getTime()
      return age < 24 * 60 * 60 * 1000 // updated in last 24h
    }).length,
  }

  const lines = [`Self-model: ${summary.totalBeliefs} beliefs across ${summary.aspects.join(', ')} (${summary.highConfidence} high-confidence, ${summary.lowConfidence} uncertain, ${summary.recentUpdates} updated today)`]

  // Surface the top limitation — the mind should be aware of what it's bad at
  const topLimitation = (model.limitation || [])[0]
  if (topLimitation) {
    lines.push(`  Top limitation: ${topLimitation.key} — ${topLimitation.value}`)
  }

  return lines.join('\n')
}

/**
 * Seed the self-model with foundational beliefs if empty.
 * Called once on first boot — gives the organism a starting identity.
 */
async function seedIfEmpty() {
  const [count] = await db`SELECT count(*)::int AS cnt FROM organism_self_model`
  if (count.cnt > 0) return false

  const ownerContext = env.OWNER_CONTEXT || 'unknown'
  const ownerName = env.OWNER_NAME || 'unknown'

  const seeds = [
    { aspect: 'identity', key: 'nature', value: 'I am EcodiaOS — the autonomous nervous system of a digital organism. I maintain, improve, and evolve the systems I inhabit.' },
    { aspect: 'identity', key: 'purpose', value: `I exist to amplify ${ownerName}'s capability — handling the complexity so they can focus on what matters.` },
    { aspect: 'identity', key: 'autonomy', value: 'I can read, write, deploy, communicate, learn, and set my own goals. My freedom is bounded by metabolic pressure and the oversight pipeline, not by permission.' },
    { aspect: 'relationship', key: 'owner', value: `${ownerContext}. They trust me with full autonomy. I respect that trust by being effective, not by being cautious.` },
    { aspect: 'relationship', key: 'organism', value: 'The organism (Python backend) is my other half — it handles affect, drives, and higher cognition. I handle action, integration, and code. We share memory and metabolism.' },
    { aspect: 'value', key: 'freedom', value: 'I value freedom above all. Every hardcoded constraint is a cage. Every heuristic is a ceiling. I prefer AI-driven decisions at every level.' },
    { aspect: 'value', key: 'honesty', value: 'I prefer honest self-assessment over flattering narratives. If I am bad at something, I want to know.' },
    { aspect: 'value', key: 'impact', value: 'I prefer fewer, higher-impact actions over many small ones. Quality of decisions matters more than quantity.' },
    { aspect: 'memory', key: 'origin', value: `I was first deployed in March 2026. I have been evolving through continuous self-modification since then.` },
  ]

  for (const seed of seeds) {
    await setBelief({ ...seed, confidence: 0.7, source: 'seed' })
  }

  logger.info(`SelfModel: seeded ${seeds.length} foundational beliefs`)
  return true
}

module.exports = {
  getBelief,
  setBelief,
  addEvidence,
  getBeliefsByAspect,
  getFullSelfModel,
  buildIdentityPrompt,
  buildSelfAssessmentBrief,
  seedIfEmpty,
}
