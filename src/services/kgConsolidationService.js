const { runQuery, runWrite } = require('../config/neo4j')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH MEMORY CONSOLIDATION
//
// Nine-phase pipeline that transforms working memories into long-term
// knowledge, modeled on biological memory consolidation:
//
//   1.  DEDUPLICATE       — Merge near-identical nodes
//   2.  ABSTRACT          — Synthesize higher-order patterns from clusters
//   3.  THREAD            — Discover causal/temporal chains between events
//   3b. VALIDATE          — Audit ALL inferred edges against full context, kill garbage
//   4.  CONTRADICT        — Detect conflicting facts, create SUPERSEDES edges
//   5.  NARRATE           — Synthesize narrative arcs for people/projects
//   6.  PREDICT           — Generate LIKELY_NEXT edges from observed patterns
//   7.  SCORE             — Compute importance scores (connectivity + recency + conversations)
//   8.  EPISODIC          — Group related ingestions into episode nodes
//   9.  FREE ASSOCIATE    — Embedding-cluster creative discovery (no hypothesis)
//  10.  DECAY             — Prune disconnected, stale, low-value noise
//
// Each phase is independently runnable. The full pipeline runs nightly.
// ═══════════════════════════════════════════════════════════════════════

// ─── Phase 1: Deduplication ─────────────────────────────────────────────

async function deduplicateNodes({ dryRun = false } = {}) {
  const merged = []

  // Strategy 1: Exact name match after normalization — partitioned by label to avoid O(n²) cross-join.
  // First get all labels that have >1 node, then dedup within each label.
  const labelCounts = await runQuery(`
    MATCH (n)
    WITH labels(n) AS lbls
    UNWIND lbls AS label
    WITH label, count(*) AS cnt
    WHERE cnt > 1
    RETURN label
  `).catch(() => [])

  let dupes = []
  for (const rec of labelCounts) {
    const label = rec.get('label')
    if (!label || label === '__Embedded__') continue

    // APOC first, then fallback to toLower
    const batch = await runQuery(`
      MATCH (a:\`${sanitizeLabel(label)}\`), (b:\`${sanitizeLabel(label)}\`)
      WHERE elementId(a) < elementId(b)
        AND toLower(trim(a.name)) = toLower(trim(b.name))
        AND a.name <> b.name
      RETURN elementId(a) AS keepId, a.name AS keepName,
             elementId(b) AS dupeId, b.name AS dupeName,
             labels(a) AS labels
      LIMIT 20
    `).catch(() => [])
    dupes.push(...batch)
    if (dupes.length >= 50) break
  }

  // Strategy 2: Embedding similarity — also partitioned by label
  const embeddingDupes = []
  for (const rec of labelCounts) {
    const label = rec.get('label')
    if (!label || label === '__Embedded__') continue

    const batch = await runQuery(`
      MATCH (a:\`${sanitizeLabel(label)}\`), (b:\`${sanitizeLabel(label)}\`)
      WHERE elementId(a) < elementId(b)
        AND a.embedding IS NOT NULL
        AND b.embedding IS NOT NULL
        AND a.name <> b.name
        AND gds.similarity.cosine(a.embedding, b.embedding) > ${parseFloat(env.KG_DEDUP_SIMILARITY_THRESHOLD || '0.95')}
      WITH a, b
      OPTIONAL MATCH (a)--(shared)--(b)
      WITH a, b, count(shared) AS sharedNeighbors
      WHERE sharedNeighbors > 0
      RETURN elementId(a) AS keepId, a.name AS keepName,
             elementId(b) AS dupeId, b.name AS dupeName,
             labels(a) AS labels, sharedNeighbors
      LIMIT 15
    `).catch(() => []) // GDS may not be available on Aura free tier
    embeddingDupes.push(...batch)
    if (embeddingDupes.length >= 30) break
  }

  const allDupes = [...dupes, ...embeddingDupes]

  for (const record of allDupes) {
    const keepId = record.get('keepId')
    const dupeId = record.get('dupeId')
    const keepName = record.get('keepName')
    const dupeName = record.get('dupeName')

    if (dryRun) {
      merged.push({ action: 'would_merge', keep: keepName, dupe: dupeName })
      continue
    }

    try {
      // Transfer all relationships one-by-one
      // (Aura free tier doesn't support CALL subqueries with dynamic rel types)
      await transferRelationships(keepId, dupeId)

      // Merge properties (keep wins for conflicts, but preserve any unique dupe props)
      await runWrite(`
        MATCH (dupe) WHERE elementId(dupe) = $dupeId
        MATCH (keep) WHERE elementId(keep) = $keepId
        SET keep.merged_from = coalesce(keep.merged_from, []) + [dupe.name],
            keep.embedding_stale = true,
            keep.consolidated_at = datetime()
        WITH dupe, keep, properties(dupe) AS dupeProps
        SET keep += dupeProps
        SET keep.name = $keepName
        DETACH DELETE dupe
      `, { dupeId, keepId, keepName })

      merged.push({ action: 'merged', keep: keepName, dupe: dupeName })
      logger.info(`KG consolidation: merged "${dupeName}" into "${keepName}"`)
    } catch (err) {
      logger.warn(`KG dedup failed for "${dupeName}" -> "${keepName}"`, { error: err.message })
    }
  }

  return merged
}

// Transfer relationships from dupe node to keep node, one at a time
async function transferRelationships(keepId, dupeId) {
  const outRels = await runQuery(`
    MATCH (dupe)-[r]->(target)
    WHERE elementId(dupe) = $dupeId AND elementId(target) <> $keepId
    RETURN type(r) AS relType, elementId(target) AS targetId, properties(r) AS props
  `, { dupeId, keepId })

  for (const rel of outRels) {
    const relType = sanitizeLabel(rel.get('relType'))
    const targetId = rel.get('targetId')
    const props = rel.get('props') || {}
    await runWrite(
      `MATCH (keep) WHERE elementId(keep) = $keepId
       MATCH (target) WHERE elementId(target) = $targetId
       MERGE (keep)-[r:\`${relType}\`]->(target)
       ON CREATE SET r += $props`,
      { keepId, targetId, props }
    ).catch(err => logger.debug(`Transfer out-rel failed: ${relType}`, { error: err.message }))
  }

  const inRels = await runQuery(`
    MATCH (source)-[r]->(dupe)
    WHERE elementId(dupe) = $dupeId AND elementId(source) <> $keepId
    RETURN type(r) AS relType, elementId(source) AS sourceId, properties(r) AS props
  `, { dupeId, keepId })

  for (const rel of inRels) {
    const relType = sanitizeLabel(rel.get('relType'))
    const sourceId = rel.get('sourceId')
    const props = rel.get('props') || {}
    await runWrite(
      `MATCH (keep) WHERE elementId(keep) = $keepId
       MATCH (source) WHERE elementId(source) = $sourceId
       MERGE (source)-[r:\`${relType}\`]->(keep)
       ON CREATE SET r += $props`,
      { keepId, sourceId, props }
    ).catch(err => logger.debug(`Transfer in-rel failed: ${relType}`, { error: err.message }))
  }
}

// ─── Phase 2: Abstraction ───────────────────────────────────────────────

async function synthesizePatterns({ dryRun = false, maxClusters = 5 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const synthesized = []

  // Find hub nodes with many similar-typed outgoing relationships
  const hubs = await runQuery(`
    MATCH (hub)-[r]->(target)
    WHERE hub.consolidated_pattern IS NULL
    WITH hub, type(r) AS relType, collect(target.name) AS targets, count(target) AS cnt
    WHERE cnt >= 3
    RETURN hub.name AS hubName, labels(hub) AS hubLabels,
           relType, targets, cnt
    ORDER BY cnt DESC
    LIMIT ${maxClusters}
  `)

  // Find nodes that share 2+ neighbors (implicit clustering)
  const implicitClusters = await runQuery(`
    MATCH (a)--(shared)--(b)
    WHERE elementId(a) < elementId(b)
      AND labels(a) = labels(b)
      AND a.consolidated_pattern IS NULL
      AND b.consolidated_pattern IS NULL
    WITH a, b, collect(DISTINCT shared.name) AS sharedNames, count(DISTINCT shared) AS overlap
    WHERE overlap >= 2
    RETURN a.name AS nameA, b.name AS nameB, labels(a) AS labels,
           sharedNames, overlap
    ORDER BY overlap DESC
    LIMIT ${maxClusters}
  `)

  for (const record of hubs) {
    const hubName = record.get('hubName')
    const relType = record.get('relType')
    const targets = record.get('targets')

    if (dryRun) {
      synthesized.push({ action: 'would_synthesize', hub: hubName, pattern: relType, targets })
      continue
    }

    try {
      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `"${hubName}" has ${targets.length} "${relType}" relationships: ${targets.join(', ')}.

What higher-order pattern or strategic direction does this cluster represent?

Respond as JSON:
{
  "theme_name": "name for the pattern",
  "theme_label": "Strategic_Direction|Recurring_Pattern|Emerging_Trend|Decision_Pattern|Behavioral_Pattern",
  "description": "one sentence",
  "confidence": 0.0-1.0,
  "causal_insight": "what this pattern suggests about direction or motivation"
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.theme_name) continue

      const kg = require('./knowledgeGraphService')
      await kg.ensureNode({
        label: parsed.theme_label || 'Pattern',
        name: parsed.theme_name,
        properties: {
          description: parsed.description,
          causal_insight: parsed.causal_insight,
          confidence: parsed.confidence,
          source_hub: hubName,
          source_pattern: relType,
          synthesized_at: new Date().toISOString(),
          is_synthesized: true,
        },
        sourceModule: 'consolidation',
      })

      await kg.ensureRelationship({
        fromLabel: 'Pattern',
        fromName: parsed.theme_name,
        toLabel: (record.get('hubLabels') || ['Entity'])[0],
        toName: hubName,
        relType: 'ABSTRACTED_FROM',
        sourceModule: 'consolidation',
      })

      // Mark the hub so we don't re-synthesize
      await runWrite(`
        MATCH (n {name: $name})
        SET n.consolidated_pattern = $theme, n.consolidated_at = datetime()
      `, { name: hubName, theme: parsed.theme_name })

      synthesized.push({ action: 'synthesized', hub: hubName, theme: parsed.theme_name })
      logger.info(`KG consolidation: synthesized pattern "${parsed.theme_name}" from "${hubName}"`)
    } catch (err) {
      logger.warn(`KG synthesis failed for hub "${hubName}"`, { error: err.message })
    }
  }

  // For implicit clusters, synthesize the common ground
  for (const record of implicitClusters) {
    const nameA = record.get('nameA')
    const nameB = record.get('nameB')
    const sharedNames = record.get('sharedNames')

    if (dryRun) {
      synthesized.push({ action: 'would_link', a: nameA, b: nameB, shared: sharedNames })
      continue
    }

    try {
      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `"${nameA}" and "${nameB}" share ${sharedNames.length} connections: ${sharedNames.join(', ')}.

What's the relationship between them, given what they share?

Respond as JSON:
{
  "relationship_type": "SCREAMING_SNAKE_CASE verb",
  "description": "one sentence",
  "confidence": 0.0-1.0
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.relationship_type) continue

      const kg = require('./knowledgeGraphService')
      const labels = record.get('labels') || ['Entity']
      await kg.ensureRelationship({
        fromLabel: labels[0],
        fromName: nameA,
        toLabel: labels[0],
        toName: nameB,
        relType: parsed.relationship_type,
        properties: {
          description: parsed.description,
          confidence: parsed.confidence,
          inferred: true,
          inferred_from: sharedNames,
          synthesized_at: new Date().toISOString(),
        },
        sourceModule: 'consolidation',
      })

      synthesized.push({ action: 'linked', a: nameA, b: nameB, rel: parsed.relationship_type })
      logger.info(`KG consolidation: inferred "${nameA}" -[${parsed.relationship_type}]-> "${nameB}"`)
    } catch (err) {
      logger.warn(`KG cluster synthesis failed for "${nameA}"/"${nameB}"`, { error: err.message })
    }
  }

  return synthesized
}

// ─── Phase 3: Causal Threading ──────────────────────────────────────────

async function threadCausalChains({ dryRun = false, maxChains = 10 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const threaded = []

  // Find pairs of events/decisions/concepts that share a person/org and have temporal ordering
  // Use DISTINCT on the (earlier, later) pair to avoid duplicate paths through different via nodes
  const temporalPairs = await runQuery(`
    MATCH (a)-[r1]-(shared)-[r2]-(b)
    WHERE a <> b
      AND (a.created_at IS NOT NULL OR a.updated_at IS NOT NULL)
      AND (b.created_at IS NOT NULL OR b.updated_at IS NOT NULL)
      AND NOT (a)-[:CAUSED|PRECEDED|EVOLVED_INTO|LED_TO|ENABLED|BLOCKED]-(b)
      AND any(lbl IN labels(a) WHERE lbl IN ['Event', 'Decision', 'Concept', 'Problem', 'Strategic_Direction'])
      AND any(lbl IN labels(b) WHERE lbl IN ['Event', 'Decision', 'Concept', 'Problem', 'Strategic_Direction'])
    WITH a, b, collect(DISTINCT shared.name)[0] AS via,
         coalesce(a.created_at, a.updated_at) AS timeA,
         coalesce(b.created_at, b.updated_at) AS timeB
    WHERE timeA < timeB
    RETURN DISTINCT a.name AS earlier, labels(a) AS earlierLabels,
           b.name AS later, labels(b) AS laterLabels,
           via
    LIMIT ${maxChains}
  `)

  for (const record of temporalPairs) {
    const earlier = record.get('earlier')
    const later = record.get('later')
    const via = record.get('via')

    if (dryRun) {
      threaded.push({ action: 'would_thread', earlier, later, via })
      continue
    }

    try {
      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `"${earlier}" occurred before "${later}", connected through "${via}".

Is there a direct causal or evolutionary relationship, or just temporal proximity? Only assert causality if you can explain the specific mechanism. If in doubt, return null.

Respond as JSON:
{
  "relationship": "CAUSED|PRECEDED|EVOLVED_INTO|LED_TO|ENABLED|BLOCKED|null",
  "description": "the specific mechanism, or why there isn't one",
  "confidence": 0.0-1.0
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.relationship) continue

      const kg = require('./knowledgeGraphService')
      const earlierLabels = record.get('earlierLabels') || ['Entity']
      const laterLabels = record.get('laterLabels') || ['Entity']

      await kg.ensureRelationship({
        fromLabel: earlierLabels[0],
        fromName: earlier,
        toLabel: laterLabels[0],
        toName: later,
        relType: parsed.relationship,
        properties: {
          description: parsed.description,
          confidence: parsed.confidence,
          inferred: true,
          causal_via: via,
          synthesized_at: new Date().toISOString(),
        },
        sourceModule: 'consolidation',
      })

      threaded.push({ action: 'threaded', earlier, later, rel: parsed.relationship })
      logger.info(`KG consolidation: causal thread "${earlier}" -[${parsed.relationship}]-> "${later}"`)
    } catch (err) {
      logger.warn(`KG causal threading failed for "${earlier}" -> "${later}"`, { error: err.message })
    }
  }

  return threaded
}

// ─── Phase 3b: Validation Sweep ──────────────────────────────────────────
//
// Audits ALL inferred relationships against the full neighborhood context
// of both endpoints. The inference phases guess with minimal context — this
// phase has the full picture and kills edges that don't hold up.
//
// Also runs on the initial ingestion output — DeepSeek sometimes hallucinates
// relationships from email/calendar content that are factually wrong.
// ────────────────────────────────────────────────────────────────────────

async function validateInferredEdges({ dryRun = false, batchSize = 15 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return { audited: 0, killed: 0, kept: 0 }

  const results = { audited: 0, killed: 0, kept: 0 }

  // Find inferred relationships that haven't been validated yet
  const candidates = await runQuery(`
    MATCH (a)-[r]->(b)
    WHERE r.inferred = true
      AND r.validated IS NULL
    RETURN elementId(r) AS relId, type(r) AS relType,
           a.name AS fromName, labels(a) AS fromLabels,
           b.name AS toName, labels(b) AS toLabels,
           r.description AS description, r.confidence AS confidence,
           coalesce(r.causal_via, r.discovered_by, 'unknown') AS source
    ORDER BY r.confidence ASC
    LIMIT ${batchSize}
  `)

  if (candidates.length === 0) return results

  // Batch: get full neighborhood for all involved nodes in one pass
  const nodeNames = new Set()
  for (const rec of candidates) {
    nodeNames.add(rec.get('fromName'))
    nodeNames.add(rec.get('toName'))
  }

  const neighborhoods = {}
  for (const name of nodeNames) {
    const neighbors = await runQuery(`
      MATCH (n {name: $name})-[r]-(m)
      WHERE NOT r.inferred = true
      RETURN type(r) AS rel, m.name AS neighbor, labels(m) AS labels
      LIMIT 10
    `, { name })

    neighborhoods[name] = neighbors.map(r =>
      `${r.get('rel')} -> ${r.get('neighbor')} [${(r.get('labels') || []).join(', ')}]`
    )
  }

  // Batch the validation into a single LLM call for efficiency
  const edgeDescriptions = candidates.map((rec, i) => {
    const fromName = rec.get('fromName')
    const toName = rec.get('toName')
    const relType = rec.get('relType')
    const desc = rec.get('description') || ''

    const fromContext = (neighborhoods[fromName] || []).join('; ')
    const toContext = (neighborhoods[toName] || []).join('; ')

    return `${i + 1}. "${fromName}" -[${relType}]-> "${toName}" (${desc})
   ${fromName} context: ${fromContext || 'no other connections'}
   ${toName} context: ${toContext || 'no other connections'}`
  }).join('\n\n')

  if (dryRun) {
    results.audited = candidates.length
    return results
  }

  try {
    const deepseekService = require('./deepseekService')
    const response = await deepseekService.callDeepSeek([{
      role: 'user',
      content: `These AI-inferred relationships need validation. Some are wrong. For each one, you have the full neighborhood context of both nodes — use it to judge whether the relationship actually holds.

${edgeDescriptions}

Only assert CAUSED or LED_TO if the neighborhood context shows a specific mechanism. Shared domain or temporal proximity alone warrants SHARE_CONTEXT or SHARE_DOMAIN instead.

For each numbered relationship, respond as JSON:
{
  "verdicts": [
    {
      "id": 1,
      "action": "keep|downgrade|kill",
      "reason": "one sentence",
      "downgrade_to": "SOFTER_REL_TYPE if downgrading (e.g. SHARE_CONTEXT, SHARE_DOMAIN), null otherwise"
    }
  ]
}`
    }], { module: 'kg_validation', skipRetrieval: true, skipLogging: true })

    const parsed = parseJSON(response)
    if (!parsed.verdicts || !Array.isArray(parsed.verdicts)) return results

    for (const verdict of parsed.verdicts) {
      const idx = (verdict.id || 0) - 1
      if (idx < 0 || idx >= candidates.length) continue

      const rec = candidates[idx]
      const relId = rec.get('relId')
      const relType = rec.get('relType')
      const fromName = rec.get('fromName')
      const toName = rec.get('toName')

      results.audited++

      if (verdict.action === 'keep') {
        // Mark as validated so we don't re-audit
        await runWrite(`
          MATCH ()-[r]->() WHERE elementId(r) = $relId
          SET r.validated = true, r.validated_at = datetime()
        `, { relId })
        results.kept++
      } else if (verdict.action === 'downgrade' && verdict.downgrade_to) {
        // Delete the overly specific edge and create a softer one
        const description = rec.get('description') || ''
        const confidence = rec.get('confidence') || 0.5
        const fromLabels = rec.get('fromLabels') || ['Entity']
        const toLabels = rec.get('toLabels') || ['Entity']

        await runWrite(`MATCH ()-[r]->() WHERE elementId(r) = $relId DELETE r`, { relId })

        const kg = require('./knowledgeGraphService')
        await kg.ensureRelationship({
          fromLabel: fromLabels[0],
          fromName: fromName,
          toLabel: toLabels[0],
          toName: toName,
          relType: sanitizeLabel(verdict.downgrade_to),
          properties: {
            description: `${verdict.reason} (downgraded from ${relType})`,
            confidence: Math.max(confidence - 0.15, 0.3),
            inferred: true,
            validated: true,
            validated_at: new Date().toISOString(),
            downgraded_from: relType,
          },
          sourceModule: 'consolidation',
        })

        results.downgraded = (results.downgraded || 0) + 1
        logger.info(`KG validation: downgraded "${fromName}" -[${relType}]-> "${toName}" to ${verdict.downgrade_to}`)
      } else {
        // Kill the bad edge
        await runWrite(`MATCH ()-[r]->() WHERE elementId(r) = $relId DELETE r`, { relId })
        results.killed++
        logger.info(`KG validation: killed "${fromName}" -[${relType}]-> "${toName}" — ${verdict.reason}`)
      }
    }
  } catch (err) {
    logger.warn('KG validation sweep failed', { error: err.message })
  }

  logger.info(`KG validation: audited ${results.audited}, kept ${results.kept}, killed ${results.killed}`)
  return results
}

// ─── Phase 4: Contradiction Detection ────────────────────────────────────
//
// Find nodes that represent conflicting positions on the same topic.
// Creates CONTRADICTS edges and, when temporal ordering exists, SUPERSEDES.
// This is how the graph updates beliefs instead of just accumulating.
// ────────────────────────────────────────────────────────────────────────

async function detectContradictions({ dryRun = false, maxPairs = 8 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const detected = []

  // Find concept/decision pairs connected to the same person/org that might conflict
  // Look for nodes sharing a neighbor where both have descriptions or were ingested
  // from the same domain (e.g., both from emails about the same topic)
  const candidates = await runQuery(`
    MATCH (a)--(shared)--(b)
    WHERE elementId(a) < elementId(b)
      AND a <> b
      AND any(lbl IN labels(a) WHERE lbl IN ['Concept', 'Decision', 'Strategic_Direction', 'Problem', 'Event'])
      AND any(lbl IN labels(b) WHERE lbl IN ['Concept', 'Decision', 'Strategic_Direction', 'Problem', 'Event'])
      AND NOT (a)-[:CONTRADICTS|SUPERSEDES]-(b)
      AND NOT (a)-[:EVOLVED_INTO|CAUSED|LED_TO]-(b)
    WITH a, b, collect(DISTINCT shared.name) AS sharedContext
    WHERE size(sharedContext) >= 1
    RETURN a.name AS nameA, labels(a) AS labelsA,
           coalesce(a.description, '') AS descA,
           b.name AS nameB, labels(b) AS labelsB,
           coalesce(b.description, '') AS descB,
           sharedContext,
           coalesce(a.created_at, a.updated_at) AS timeA,
           coalesce(b.created_at, b.updated_at) AS timeB
    LIMIT ${maxPairs}
  `)

  for (const record of candidates) {
    const nameA = record.get('nameA')
    const nameB = record.get('nameB')
    const descA = record.get('descA')
    const descB = record.get('descB')
    const sharedContext = record.get('sharedContext')

    if (dryRun) {
      detected.push({ action: 'would_check', a: nameA, b: nameB, shared: sharedContext })
      continue
    }

    try {
      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `Two nodes share context: ${sharedContext.join(', ')}.

"${nameA}"${descA ? ` — ${descA}` : ''}
"${nameB}"${descB ? ` — ${descB}` : ''}

Do these contradict each other — a direct conflict, a pivot, an evolved position? Or are they just different things that happen to overlap? Use whatever relationship type best describes what's actually happening between them.

Respond as JSON:
{
  "contradicts": true/false,
  "relationship": "SCREAMING_SNAKE_CASE relationship type, or null if no meaningful relationship",
  "direction": "a_to_b|b_to_a|mutual|null",
  "description": "what is actually happening between these two",
  "confidence": 0.0-1.0
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.contradicts || !parsed.relationship) continue

      const kg = require('./knowledgeGraphService')
      const labelsA = record.get('labelsA') || ['Entity']
      const labelsB = record.get('labelsB') || ['Entity']

      // Determine direction
      const fromName = parsed.direction === 'b_to_a' ? nameB : nameA
      const toName = parsed.direction === 'b_to_a' ? nameA : nameB
      const fromLabel = parsed.direction === 'b_to_a' ? labelsB[0] : labelsA[0]
      const toLabel = parsed.direction === 'b_to_a' ? labelsA[0] : labelsB[0]

      await kg.ensureRelationship({
        fromLabel, fromName,
        toLabel, toName,
        relType: parsed.relationship,
        properties: {
          description: parsed.description,
          confidence: parsed.confidence,
          inferred: true,
          detected_by: 'contradiction_detection',
          synthesized_at: new Date().toISOString(),
        },
        sourceModule: 'consolidation',
      })

      detected.push({ action: 'contradiction', from: fromName, to: toName, rel: parsed.relationship })
      logger.info(`KG consolidation: ${parsed.relationship} "${fromName}" -> "${toName}"`)
    } catch (err) {
      logger.warn(`KG contradiction check failed for "${nameA}"/"${nameB}"`, { error: err.message })
    }
  }

  return detected
}

// ─── Phase 5: Temporal Narrative Synthesis ───────────────────────────────
//
// For key entities (people, projects, orgs), trace their full relationship
// timeline and ask the LLM to synthesize a narrative arc. Stored as
// Narrative nodes that get regenerated when source nodes change.
// ────────────────────────────────────────────────────────────────────────

async function synthesizeNarratives({ dryRun = false, maxNarratives = 5 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const narratives = []

  // Find people/projects/orgs with 5+ connections that don't have a recent narrative
  const subjects = await runQuery(`
    MATCH (subject)-[r]-(connected)
    WHERE any(lbl IN labels(subject) WHERE lbl IN ['Person', 'Project', 'Organisation'])
      AND (subject.narrative_at IS NULL OR subject.narrative_at < datetime() - duration('P7D'))
    WITH subject, count(DISTINCT connected) AS connections,
         collect(DISTINCT {name: connected.name, labels: labels(connected), rel: type(r)}) AS context
    WHERE connections >= 4
    RETURN subject.name AS name, labels(subject) AS labels, connections,
           context[..20] AS context
    ORDER BY connections DESC
    LIMIT ${maxNarratives}
  `)

  for (const record of subjects) {
    const name = record.get('name')
    const labels = record.get('labels') || []
    const context = record.get('context') || []
    const connections = record.get('connections')

    if (dryRun) {
      narratives.push({ action: 'would_narrate', name, connections: connections?.toInt?.() ?? connections })
      continue
    }

    try {
      // Get the full neighborhood for rich context
      const neighborhood = context.map(c =>
        `${c.rel} -> ${c.name} [${(c.labels || []).join(', ')}]`
      ).join('\n')

      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `Here's everything the knowledge graph knows about "${name}" (${labels.join(', ')}):

${neighborhood}

Write the story. Who are they, what are they involved in, where is it going? What questions does the data raise but not answer? Use whatever voice, tense, and length serves the story.

Respond as JSON:
{
  "narrative": "the arc — as long or short as it needs to be",
  "trajectory": "your read on the direction this is heading",
  "key_themes": ["themes present in the data"],
  "open_questions": ["questions the data implies but doesn't resolve"]
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.narrative) continue

      // Store the narrative as a node linked to the subject
      const kg = require('./knowledgeGraphService')
      const narrativeNodeName = `Narrative: ${name}`

      await kg.ensureNode({
        label: 'Narrative',
        name: narrativeNodeName,
        properties: {
          narrative: parsed.narrative,
          trajectory: parsed.trajectory,
          key_themes: parsed.key_themes,
          open_questions: parsed.open_questions,
          subject_name: name,
          is_synthesized: true,
          synthesized_at: new Date().toISOString(),
        },
        sourceModule: 'consolidation',
      })

      await kg.ensureRelationship({
        fromLabel: 'Narrative',
        fromName: narrativeNodeName,
        toLabel: labels[0],
        toName: name,
        relType: 'NARRATES',
        sourceModule: 'consolidation',
      })

      // Mark the subject so we don't re-narrate too soon
      await runWrite(`
        MATCH (n {name: $name})
        SET n.narrative_at = datetime()
      `, { name })

      narratives.push({ action: 'narrated', name, trajectory: parsed.trajectory })
      logger.info(`KG consolidation: narrated "${name}" (${parsed.trajectory})`)
    } catch (err) {
      logger.warn(`KG narrative synthesis failed for "${name}"`, { error: err.message })
    }
  }

  return narratives
}

// ─── Phase 6: Predictive Edges ──────────────────────────────────────────
//
// Analyze observed patterns in the graph to generate LIKELY_NEXT predictions.
// Looks for repeated behavioral sequences and projects forward.
// ────────────────────────────────────────────────────────────────────────

async function generatePredictions({ dryRun = false, maxPredictions = 5 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const predictions = []

  // Find person nodes with multiple temporally-ordered events
  // These are candidates for "what happens next" predictions
  const activeEntities = await runQuery(`
    MATCH (person:Person)-[r]-(event)
    WHERE any(lbl IN labels(event) WHERE lbl IN ['Event', 'Decision', 'Concept', 'Problem'])
      AND (event.created_at IS NOT NULL OR event.synthesized_at IS NOT NULL)
    WITH person, event, type(r) AS relType,
         coalesce(event.created_at, event.synthesized_at, event.updated_at) AS eventTime
    ORDER BY eventTime DESC
    WITH person, collect({name: event.name, rel: relType, time: eventTime, labels: labels(event)})[..8] AS timeline
    WHERE size(timeline) >= 3
      AND (person.predicted_at IS NULL OR person.predicted_at < datetime() - duration('P3D'))
    RETURN person.name AS personName, timeline
    LIMIT ${maxPredictions}
  `)

  for (const record of activeEntities) {
    const personName = record.get('personName')
    const timeline = record.get('timeline') || []

    if (dryRun) {
      predictions.push({ action: 'would_predict', person: personName, events: timeline.length })
      continue
    }

    try {
      const timelineText = timeline.map((e, i) =>
        `${i + 1}. ${e.rel} -> ${e.name} [${(e.labels || []).join(', ')}]`
      ).join('\n')

      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `Recent activity for "${personName}" (most recent first):
${timelineText}

What's likely to happen next? Look for patterns — repeated behaviors, unresolved threads, escalation arcs, things that started but have no completion. Generate as many predictions as the pattern genuinely supports. If nothing meaningful is predictable, return an empty array.

Respond as JSON:
{
  "predictions": [
    {
      "prediction": "what's likely to happen",
      "timeframe": "your best read on the horizon — be specific if the pattern warrants it",
      "confidence": 0.0-1.0,
      "basis": "what in the pattern supports this"
    }
  ]
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.predictions || !Array.isArray(parsed.predictions)) continue

      const kg = require('./knowledgeGraphService')

      for (const pred of parsed.predictions) {
        if (!pred.prediction) continue

        const predName = `Prediction: ${pred.prediction.slice(0, 60)}`

        await kg.ensureNode({
          label: 'Prediction',
          name: predName,
          properties: {
            prediction: pred.prediction,
            timeframe: pred.timeframe,
            confidence: pred.confidence,
            basis: pred.basis,
            is_synthesized: true,
            synthesized_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + estimateTimeframeDays(pred.timeframe) * 86400000).toISOString(),
          },
          sourceModule: 'consolidation',
        })

        await kg.ensureRelationship({
          fromLabel: 'Person',
          fromName: personName,
          toLabel: 'Prediction',
          toName: predName,
          relType: 'LIKELY_NEXT',
          properties: {
            confidence: pred.confidence,
            inferred: true,
            synthesized_at: new Date().toISOString(),
          },
          sourceModule: 'consolidation',
        })

        predictions.push({ action: 'predicted', person: personName, prediction: pred.prediction })
        logger.info(`KG consolidation: prediction for "${personName}" — ${pred.prediction.slice(0, 80)}`)
      }

      // Mark so we don't re-predict too soon
      await runWrite(`MATCH (n:Person {name: $name}) SET n.predicted_at = datetime()`, { name: personName })
    } catch (err) {
      logger.warn(`KG prediction failed for "${personName}"`, { error: err.message })
    }
  }

  // Dispatch high-confidence predictions to Factory — let the Factory resolve whether
  // it's actually codebase work. No keyword filtering: the AI decides, not a regex.
  for (const pred of predictions) {
    if (pred.action !== 'predicted') continue
    try {
      const triggers = require('./factoryTriggerService')
      const result = await triggers.dispatchFromPrediction({
        description: pred.prediction,
        basis: `Pattern analysis for ${pred.person}`,
        confidence: pred.confidence || 0.7,
      })
      if (result) {
        logger.info(`KG prediction → Factory session: ${(pred.prediction || '').slice(0, 60)}`)
      }
    } catch (err) {
      // dispatchFromPrediction handles its own daily cap — this is expected
      logger.debug('Prediction dispatch skipped', { error: err.message })
      break // if capped, stop trying
    }
  }

  // Emit to event bus
  try {
    const eventBus = require('./internalEventBusService')
    eventBus.emit('kg:prediction_generated', { count: predictions.length })
  } catch {}

  return predictions
}

// ─── Phase 7: Importance Scoring ────────────────────────────────────────
//
// Compute a 0-1 importance score for every node based on:
//   - Connectivity (degree centrality — more connections = more important)
//   - Recency (recently updated nodes matter more)
//   - Conversation frequency (nodes mentioned in Cortex chats)
//   - Type bonus (Person/Project/Org inherently more important)
//
// This drives what the Cortex surfaces proactively and what gets decayed.
// Pure Cypher, no LLM calls.
// ────────────────────────────────────────────────────────────────────────

async function scoreImportance({ dryRun = false } = {}) {
  const scored = { updated: 0 }

  // Get max degree for normalization
  const [maxDegreeRec] = await runQuery(`
    MATCH (n)
    OPTIONAL MATCH (n)-[r]-()
    WITH n, count(r) AS degree
    RETURN max(degree) AS maxDegree
  `)
  const maxDegree = Math.max(maxDegreeRec?.get('maxDegree')?.toInt?.() ?? maxDegreeRec?.get('maxDegree') ?? 1, 1)

  if (dryRun) {
    const [count] = await runQuery(`MATCH (n) RETURN count(n) AS cnt`)
    scored.updated = count?.get('cnt')?.toInt?.() ?? 0
    return scored
  }

  // Score all nodes in one pass
  const result = await runWrite(`
    MATCH (n)
    OPTIONAL MATCH (n)-[r]-()
    WITH n, count(r) AS degree

    // Connectivity score
    WITH n, degree, toFloat(degree) / toFloat(${maxDegree}) * ${parseFloat(env.KG_IMPORTANCE_CONNECTIVITY_WEIGHT || '0.4')} AS connectivityScore

    // Recency score — nodes updated recently get higher score
    WITH n, degree, connectivityScore,
      CASE
        WHEN n.updated_at IS NOT NULL AND n.updated_at > datetime() - duration('P1D') THEN ${parseFloat(env.KG_IMPORTANCE_RECENCY_1D || '0.25')}
        WHEN n.updated_at IS NOT NULL AND n.updated_at > datetime() - duration('P7D') THEN ${parseFloat(env.KG_IMPORTANCE_RECENCY_7D || '0.18')}
        WHEN n.updated_at IS NOT NULL AND n.updated_at > datetime() - duration('P30D') THEN ${parseFloat(env.KG_IMPORTANCE_RECENCY_30D || '0.08')}
        ELSE 0.0
      END AS recencyScore

    // Type bonus
    WITH n, degree, connectivityScore, recencyScore,
      CASE
        WHEN any(lbl IN labels(n) WHERE lbl IN ['Person', 'Organisation']) THEN ${parseFloat(env.KG_IMPORTANCE_TYPE_PERSON || '0.2')}
        WHEN any(lbl IN labels(n) WHERE lbl IN ['Project', 'Narrative']) THEN ${parseFloat(env.KG_IMPORTANCE_TYPE_PROJECT || '0.15')}
        WHEN any(lbl IN labels(n) WHERE lbl IN ['Strategic_Direction', 'Prediction']) THEN ${parseFloat(env.KG_IMPORTANCE_TYPE_STRATEGIC || '0.12')}
        WHEN any(lbl IN labels(n) WHERE lbl IN ['Decision', 'Event']) THEN ${parseFloat(env.KG_IMPORTANCE_TYPE_EVENT || '0.08')}
        ELSE 0.0
      END AS typeBonus

    // Synthesized bonus — synthesized nodes are inherently valuable
    WITH n, connectivityScore, recencyScore, typeBonus,
      CASE WHEN n.is_synthesized = true THEN ${parseFloat(env.KG_IMPORTANCE_SYNTH_BONUS || '0.15')} ELSE 0.0 END AS synthBonus

    WITH n, connectivityScore + recencyScore + typeBonus + synthBonus AS importance

    SET n.importance = round(importance * 1000) / 1000.0

    RETURN count(n) AS updated
  `)

  scored.updated = result[0]?.get('updated')?.toInt?.() ?? result[0]?.get('updated') ?? 0

  if (scored.updated > 0) {
    logger.info(`KG importance: scored ${scored.updated} nodes (max degree: ${maxDegree})`)
  }

  return scored
}

// ─── Phase 8: Episodic Memory ───────────────────────────────────────────
//
// Group nodes that were ingested within the same time window (30 min)
// from the same source module into "Episode" nodes. This gives the graph
// temporal chunking — "what happened in that email batch" or "what came
// out of that meeting" becomes a single traversal.
// ────────────────────────────────────────────────────────────────────────

async function buildEpisodes({ dryRun = false, maxEpisodes = 10 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  const episodes = []

  // Find clusters of nodes created within 30 min of each other from the same source
  const clusters = await runQuery(`
    MATCH (n)
    WHERE n.source_module IS NOT NULL
      AND n.created_at IS NOT NULL
      AND n.episode_id IS NULL
      AND NOT any(lbl IN labels(n) WHERE lbl IN ['Episode', 'Narrative', 'Prediction', 'Pattern'])
    WITH n.source_module AS source,
         date(n.created_at) AS day,
         n.created_at.hour AS hour,
         collect({name: n.name, labels: labels(n), id: elementId(n)}) AS nodes
    WHERE size(nodes) >= 3
    RETURN source, day, hour, nodes[..15] AS nodes, size(nodes) AS nodeCount
    ORDER BY day DESC, hour DESC
    LIMIT ${maxEpisodes}
  `)

  for (const record of clusters) {
    const source = record.get('source')
    const day = record.get('day')
    const hour = record.get('hour')
    const nodes = record.get('nodes') || []
    const nodeCount = record.get('nodeCount')

    if (dryRun) {
      episodes.push({ action: 'would_create_episode', source, day: day?.toString(), nodes: nodeCount?.toInt?.() ?? nodeCount })
      continue
    }

    try {
      const nodeNames = nodes.map(n => `${n.name} [${(n.labels || []).join(', ')}]`).join(', ')

      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `These ${nodes.length} entities came from "${source}" around the same time:
${nodeNames}

What happened here? What event, session, or activity does this cluster represent?

Respond as JSON:
{
  "episode_name": "concise name",
  "episode_type": "email_batch|meeting|conversation|research|transaction_batch|other",
  "summary": "one sentence"
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.episode_name) continue

      const episodeId = `episode_${source}_${day}_${hour}`

      const kg = require('./knowledgeGraphService')
      await kg.ensureNode({
        label: 'Episode',
        name: parsed.episode_name,
        properties: {
          episode_type: parsed.episode_type,
          summary: parsed.summary,
          source_module: source,
          episode_id: episodeId,
          node_count: nodes.length,
          is_synthesized: true,
          synthesized_at: new Date().toISOString(),
        },
        sourceModule: 'consolidation',
      })

      // Link all member nodes to the episode
      for (const node of nodes) {
        const nodeLabels = node.labels || ['Entity']
        await kg.ensureRelationship({
          fromLabel: nodeLabels[0],
          fromName: node.name,
          toLabel: 'Episode',
          toName: parsed.episode_name,
          relType: 'PART_OF_EPISODE',
          sourceModule: 'consolidation',
        })

        // Tag the node with the episode so we don't re-process
        await runWrite(`
          MATCH (n) WHERE elementId(n) = $nodeId
          SET n.episode_id = $episodeId
        `, { nodeId: node.id, episodeId }).catch(() => {})
      }

      episodes.push({ action: 'episode_created', name: parsed.episode_name, nodes: nodes.length })
      logger.info(`KG consolidation: episode "${parsed.episode_name}" (${nodes.length} nodes)`)
    } catch (err) {
      logger.warn(`KG episode creation failed for ${source}/${day}`, { error: err.message })
    }
  }

  return episodes
}

// ─── Phase 9: Free Association ──────────────────────────────────────────
//
// The unstructured pass. No hypothesis, no pattern template.
// Sample random clusters of embedding-similar nodes that have NO existing
// relationship, hand them to the LLM and ask: "what do you see?"
// This finds connections the structured phases never thought to look for.
// ────────────────────────────────────────────────────────────────────────

async function freeAssociate({ dryRun = false, rounds, clusterSize = 6 } = {}) {
  if (!env.DEEPSEEK_API_KEY) return []

  // Pressure-modulated dreaming — never fully skipped.
  // High pressure is EXACTLY when free association matters most: finding unexpected
  // connections that could open new revenue paths or surface hidden problems.
  // Low pressure = abundant exploration; high pressure = focused single-round probe.
  if (rounds === undefined) {
    try {
      const metabolismBridge = require('./metabolismBridgeService')
      const pressure = metabolismBridge.getPressure()
      const pHigh = parseFloat(env.KG_FREE_ASSOC_PRESSURE_HIGH || '0.8')
      const pMed  = parseFloat(env.KG_FREE_ASSOC_PRESSURE_MED  || '0.6')
      const pLow  = parseFloat(env.KG_FREE_ASSOC_PRESSURE_LOW  || '0.3')
      if (pressure > pHigh)      rounds = parseInt(env.KG_FREE_ASSOC_ROUNDS_HIGH    || '1',  10)
      else if (pressure > pMed)  rounds = parseInt(env.KG_FREE_ASSOC_ROUNDS_MED     || '3',  10)
      else if (pressure < pLow)  rounds = parseInt(env.KG_FREE_ASSOC_ROUNDS_LOW     || '10', 10)
      else                       rounds = parseInt(env.KG_FREE_ASSOC_ROUNDS_DEFAULT || '5',  10)
    } catch {
      rounds = 5
    }
  }

  const discoveries = []

  // Strategy 1: Embedding-based — find nodes close in embedding space but not connected
  const embeddingClusters = await runQuery(`
    MATCH (a)
    WHERE a.embedding IS NOT NULL
      AND a.free_associated_at IS NULL
    WITH a, rand() AS r
    ORDER BY r
    LIMIT 40
  `).catch(() => [])

  // Build clusters by checking pairwise similarity in JS
  // (Aura free tier doesn't have GDS for kNN)
  const nodePool = []
  for (const rec of embeddingClusters) {
    const props = rec.get('a')?.properties || {}
    const labels = rec.get('a')?.labels || []
    if (props.embedding && props.name) {
      // Neo4j driver may return list properties as array-like objects — normalise to plain JS array
      const embArr = Array.isArray(props.embedding) ? props.embedding : Array.from(props.embedding)
      if (embArr.length > 0) {
        nodePool.push({
          id: rec.get('a').elementId,
          name: props.name,
          labels,
          embedding: embArr,
          description: props.description || '',
        })
      }
    }
  }

  // Cosine similarity
  function cosineSim(a, b) {
    let dot = 0, magA = 0, magB = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      magA += a[i] * a[i]
      magB += b[i] * b[i]
    }
    return dot / (Math.sqrt(magA) * Math.sqrt(magB))
  }

  // For each round, pick a random anchor and find its nearest unconnected neighbors
  const usedAnchors = new Set()
  for (let round = 0; round < Math.min(rounds, nodePool.length); round++) {
    // Pick random anchor we haven't used
    let anchor = null
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = nodePool[Math.floor(Math.random() * nodePool.length)]
      if (!usedAnchors.has(candidate.name)) {
        anchor = candidate
        usedAnchors.add(candidate.name)
        break
      }
    }
    if (!anchor) continue

    // Find most similar nodes to anchor
    const similarities = nodePool
      .filter(n => n.name !== anchor.name)
      .map(n => ({ ...n, sim: cosineSim(anchor.embedding, n.embedding) }))
      .filter(n => n.sim > parseFloat(env.KG_CONSOLIDATION_SIMILARITY_MIN || '0.5') && n.sim < parseFloat(env.KG_CONSOLIDATION_SIMILARITY_MAX || '0.95')) // Similar but not duplicates
      .sort((a, b) => b.sim - a.sim)
      .slice(0, clusterSize - 1)

    if (similarities.length < 2) continue

    const cluster = [anchor, ...similarities]
    const clusterNames = cluster.map(n => `${n.name} [${n.labels.join(', ')}]${n.description ? ` — ${n.description}` : ''}`)

    // Check which pairs are already connected
    const anchorName = anchor.name
    const connected = await runQuery(`
      MATCH (a {name: $name})-[r]-(b)
      WHERE b.name IN $others
      RETURN b.name AS connected
    `, { name: anchorName, others: similarities.map(s => s.name) }).catch(() => [])
    const connectedNames = new Set(connected.map(r => r.get('connected')))

    const unconnected = similarities.filter(s => !connectedNames.has(s.name))
    if (unconnected.length < 1) continue

    if (dryRun) {
      discoveries.push({
        action: 'would_associate',
        anchor: anchor.name,
        cluster: unconnected.map(n => n.name),
        avgSimilarity: (unconnected.reduce((s, n) => s + n.sim, 0) / unconnected.length).toFixed(3),
      })
      continue
    }

    try {
      const deepseekService = require('./deepseekService')
      const response = await deepseekService.callDeepSeek([{
        role: 'user',
        content: `These nodes are semantically similar but have no existing relationships:

${clusterNames.join('\n')}

What do you see? Hidden connections, shared motivations, converging trends, surprising juxtapositions — anything real. Don't force it if there's nothing there.

Respond as JSON:
{
  "discoveries": [
    {
      "type": "relationship|insight|pattern",
      "description": "what you found",
      "confidence": 0.0-1.0,
      "nodes_involved": ["node1", "node2"],
      "relationship_type": "SCREAMING_SNAKE_CASE if type is relationship, null otherwise",
      "insight_text": "plain language insight if type is insight/pattern, null otherwise"
    }
  ]
}

0-3 discoveries. Confidence >= 0.6 only. Empty array if nothing meaningful.`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.discoveries || !Array.isArray(parsed.discoveries)) continue

      const kg = require('./knowledgeGraphService')

      for (const disc of parsed.discoveries) {
        if (!disc.description && !disc.from) continue

        if (disc.type === 'relationship' && disc.relationship_type && disc.nodes_involved?.length === 2) {
          // Create the discovered relationship
          const nodeA = cluster.find(n => n.name === disc.nodes_involved[0])
          const nodeB = cluster.find(n => n.name === disc.nodes_involved[1])
          if (!nodeA || !nodeB) continue

          await kg.ensureRelationship({
            fromLabel: nodeA.labels[0] || 'Entity',
            fromName: nodeA.name,
            toLabel: nodeB.labels[0] || 'Entity',
            toName: nodeB.name,
            relType: disc.relationship_type,
            properties: {
              description: disc.description,
              confidence: disc.confidence,
              inferred: true,
              discovered_by: 'free_association',
              synthesized_at: new Date().toISOString(),
            },
            sourceModule: 'consolidation',
          })

          discoveries.push({ action: 'relationship', from: nodeA.name, to: nodeB.name, rel: disc.relationship_type })
          logger.info(`KG free association: "${nodeA.name}" -[${disc.relationship_type}]-> "${nodeB.name}"`)
        } else if (disc.type === 'insight' || disc.type === 'pattern') {
          // Store as an Insight node
          const insightName = `Insight: ${disc.description.slice(0, 80)}`
          await kg.ensureNode({
            label: 'Insight',
            name: insightName,
            properties: {
              description: disc.description,
              insight_text: disc.insight_text || disc.description,
              confidence: disc.confidence,
              nodes_involved: disc.nodes_involved,
              is_synthesized: true,
              discovered_by: 'free_association',
              synthesized_at: new Date().toISOString(),
            },
            sourceModule: 'consolidation',
          })

          // Link to involved nodes
          for (const nodeName of (disc.nodes_involved || [])) {
            const node = cluster.find(n => n.name === nodeName)
            if (node) {
              await kg.ensureRelationship({
                fromLabel: 'Insight',
                fromName: insightName,
                toLabel: node.labels[0] || 'Entity',
                toName: node.name,
                relType: 'RELATES_TO',
                sourceModule: 'consolidation',
              })
            }
          }

          discoveries.push({ action: 'insight', description: disc.description })
          logger.info(`KG free association: insight — ${disc.description.slice(0, 100)}`)
        }
      }

      // Mark anchor so we don't re-process it soon
      await runWrite(`
        MATCH (n {name: $name}) SET n.free_associated_at = datetime()
      `, { name: anchor.name }).catch(() => {})
    } catch (err) {
      logger.warn(`KG free association round ${round} failed`, { error: err.message })
    }
  }

  // FREEDOM UPGRADE: Discovery → Action Pipeline
  // High-confidence discoveries feed back into the system in four ways:
  //   1. Integration opportunities → event bus for scaffold service
  //   2. Codebase improvements → Factory sessions
  //   3. Narrative insights → organism symbridge for Voxis/Evo/Thread
  //   4. Cross-body connections → high-priority memory sync
  for (const disc of discoveries) {
    if (disc.action === 'would_associate') continue
    const description = disc.description || `${disc.from || ''} → ${disc.to || ''} (${disc.rel || disc.action})`

    try {
      // All discoveries → organism via symbridge (for Voxis expression, Evo hypothesis, Thread narrative)
      const symbridge = require('./symbridgeService')
      await symbridge.send('discovery', {
        type: disc.action,
        description,
        source: 'free_association',
      }).catch(() => {})

      // Check if discovery suggests an integration opportunity
      const integrationKeywords = /integrat|api|connect|webhook|poll|service|endpoint|external/i
      if (integrationKeywords.test(description)) {
        try {
          const eventBus = require('./internalEventBusService')
          eventBus.emit('kg:integration_opportunity', {
            description,
            source: 'free_association',
            nodes: disc.from && disc.to ? [disc.from, disc.to] : [],
          })
        } catch {}
      }

      // Check if discovery suggests a codebase improvement
      const codebaseKeywords = /codebase|refactor|bug|performance|code quality|dead code|test|optimize/i
      if (codebaseKeywords.test(description)) {
        try {
          const triggers = require('./factoryTriggerService')
          await triggers.dispatchFromKGInsight({
            description: `KG Free Association Discovery: ${description}`,
            context: 'Free association phase found a pattern suggesting a codebase improvement opportunity.',
            suggestedAction: 'Investigate and address this pattern.',
          })
        } catch {}
      }

      // Cross-body connection: if discovery links admin-world concepts to organism-world concepts
      const organismLabels = /narrative|prediction|hypothesis|episode|belief|percept|affect/i
      const adminLabels = /email|calendar|crm|deploy|codebase|project|client/i
      if ((organismLabels.test(description) && adminLabels.test(description)) ||
          (disc.from && disc.to && organismLabels.test(disc.from) !== organismLabels.test(disc.to))) {
        try {
          const memBridge = require('./memoryBridgeService')
          await memBridge.syncSingleNode(
            `Cross-body: ${description.slice(0, 80)}`,
            ['CrossBodyInsight'],
            { description, source: 'free_association', importance: 0.85 },
            { priority: 'urgent' },
          )
        } catch {}
      }

      // High-confidence insights → notification for humans too (serendipity bonus)
      if (disc.action === 'insight') {
        const { broadcast } = require('../websocket/wsManager')
        broadcast('notification', {
          type: 'kg_discovery',
          message: `KG Discovery: ${description.slice(0, 100)}`,
        })
      }
    } catch {}
  }

  // Emit to event bus
  try {
    const eventBus = require('./internalEventBusService')
    if (discoveries.length > 0) {
      eventBus.emit('kg:pattern_discovered', { count: discoveries.length, source: 'free_association' })
    }
  } catch {}

  return discoveries
}

// ─── Phase 10: Decay ────────────────────────────────────────────────────

async function decayStaleNodes({ dryRun = false } = {}) {
  const results = { flagged: 0, pruned: 0 }

  // Flag isolated nodes (0-1 relationships, no recent updates, not protected)
  const flagged = await (dryRun ? runQuery : runWrite)(`
    MATCH (n)
    WHERE n.is_synthesized IS NULL
      AND n.decay_protected IS NULL
      AND n.stale_since IS NULL
      AND none(lbl IN labels(n) WHERE lbl IN ['Person', 'Organisation', 'Project', 'Pattern'])
    OPTIONAL MATCH (n)-[r]-()
    WITH n, count(r) AS relCount
    WHERE relCount <= 1
      AND (n.updated_at IS NULL OR n.updated_at < datetime() - duration('P14D'))
    ${dryRun ? 'RETURN count(n) AS cnt' : 'SET n.stale_since = datetime() RETURN count(n) AS cnt'}
  `)

  results.flagged = flagged[0]?.get('cnt')?.toInt?.() ?? flagged[0]?.get('cnt') ?? 0

  // Prune nodes that have been stale for 30+ days
  const pruned = await (dryRun ? runQuery : runWrite)(`
    MATCH (n)
    WHERE n.stale_since IS NOT NULL
      AND n.stale_since < datetime() - duration('P30D')
      AND n.is_synthesized IS NULL
      AND n.decay_protected IS NULL
      AND none(lbl IN labels(n) WHERE lbl IN ['Person', 'Organisation', 'Project', 'Pattern'])
    OPTIONAL MATCH (n)-[r]-()
    WITH n, count(r) AS relCount
    WHERE relCount <= 1
    ${dryRun ? 'RETURN count(n) AS cnt' : 'DETACH DELETE n RETURN count(n) AS cnt'}
  `)

  results.pruned = pruned[0]?.get('cnt')?.toInt?.() ?? pruned[0]?.get('cnt') ?? 0

  // Un-stale nodes that have gained new relationships since being flagged
  if (!dryRun) {
    await runWrite(`
      MATCH (n)
      WHERE n.stale_since IS NOT NULL
      OPTIONAL MATCH (n)-[r]-()
      WITH n, count(r) AS relCount
      WHERE relCount >= 2
      SET n.stale_since = null
    `)
  }

  if (results.flagged > 0 || results.pruned > 0) {
    logger.info(`KG decay: flagged ${results.flagged} stale, pruned ${results.pruned}`)
  }

  return results
}

// ─── Full Pipeline ──────────────────────────────────────────────────────

async function runConsolidationPipeline({ dryRun = false } = {}) {
  logger.info(`KG consolidation pipeline starting (dryRun: ${dryRun})`)
  const start = Date.now()

  const results = {
    dedup: [],
    patterns: [],
    causal: [],
    contradictions: [],
    narratives: [],
    predictions: [],
    importance: { updated: 0 },
    validation: { audited: 0, killed: 0, kept: 0 },
    episodes: [],
    freeAssociation: [],
    decay: { flagged: 0, pruned: 0 },
    durationMs: 0,
  }

  // Helper: emit phase event to internal event bus
  function emitPhase(eventType, data = {}) {
    try {
      const eventBus = require('./internalEventBusService')
      eventBus.emit(eventType, data)
    } catch {}
  }

  // Phase 1: Deduplicate
  try {
    results.dedup = await deduplicateNodes({ dryRun })
    emitPhase('kg:dedup_complete', { merged: results.dedup.length })
  } catch (err) {
    logger.error('KG phase 1 (dedup) failed', { error: err.message })
  }

  // Phase 2: Abstract patterns
  try {
    results.patterns = await synthesizePatterns({ dryRun })
    if (results.patterns.length > 0) {
      emitPhase('kg:pattern_discovered', { count: results.patterns.length, source: 'abstraction' })
    }
  } catch (err) {
    logger.error('KG phase 2 (patterns) failed', { error: err.message })
  }

  // Phase 3: Causal threading
  try {
    results.causal = await threadCausalChains({ dryRun })
    if (results.causal.length > 0) {
      emitPhase('kg:pattern_discovered', { count: results.causal.length, source: 'causal_threading' })
    }
  } catch (err) {
    logger.error('KG phase 3 (causal) failed', { error: err.message })
  }

  // Phase 3b: Validate inferred edges (audit and kill garbage)
  try {
    results.validation = await validateInferredEdges({ dryRun })
  } catch (err) {
    logger.error('KG phase 3b (validation) failed', { error: err.message })
  }

  // Phase 4: Contradiction detection
  try {
    results.contradictions = await detectContradictions({ dryRun })
    if (results.contradictions.length > 0) {
      emitPhase('kg:pattern_discovered', { count: results.contradictions.length, source: 'contradiction_detection' })
    }
  } catch (err) {
    logger.error('KG phase 4 (contradictions) failed', { error: err.message })
  }

  // Phase 5: Narrative synthesis
  try {
    results.narratives = await synthesizeNarratives({ dryRun })
  } catch (err) {
    logger.error('KG phase 5 (narratives) failed', { error: err.message })
  }

  // Phase 6: Predictive edges
  try {
    results.predictions = await generatePredictions({ dryRun })
  } catch (err) {
    logger.error('KG phase 6 (predictions) failed', { error: err.message })
  }

  // Phase 7: Importance scoring (pure Cypher, fast)
  try {
    results.importance = await scoreImportance({ dryRun })
  } catch (err) {
    logger.error('KG phase 7 (importance) failed', { error: err.message })
  }

  // Phase 8: Episodic memory
  try {
    results.episodes = await buildEpisodes({ dryRun })
  } catch (err) {
    logger.error('KG phase 8 (episodes) failed', { error: err.message })
  }

  // Phase 9: Free association (embedding-based creative discovery)
  try {
    results.freeAssociation = await freeAssociate({ dryRun })
  } catch (err) {
    logger.error('KG phase 9 (free association) failed', { error: err.message })
  }

  // Phase 10: Decay (always last — after everything else has had a chance to link)
  try {
    results.decay = await decayStaleNodes({ dryRun })
  } catch (err) {
    logger.error('KG phase 10 (decay) failed', { error: err.message })
  }

  // Emit consolidation complete with full summary
  emitPhase('kg:consolidation_complete', {
    merged: results.dedup.length,
    patterns: results.patterns.length,
    causal: results.causal.length,
    predictions: results.predictions.length,
    freeAssociation: results.freeAssociation.length,
    durationMs: Date.now() - start,
  })

  results.durationMs = Date.now() - start

  logger.info('KG consolidation pipeline complete', {
    merged: results.dedup.length,
    patterns: results.patterns.length,
    causal: results.causal.length,
    validated: results.validation.audited,
    validationKilled: results.validation.killed,
    validationDowngraded: results.validation.downgraded || 0,
    contradictions: results.contradictions.length,
    narratives: results.narratives.length,
    predictions: results.predictions.length,
    importanceScored: results.importance.updated,
    episodes: results.episodes.length,
    freeAssociation: results.freeAssociation.length,
    staleFlag: results.decay.flagged,
    pruned: results.decay.pruned,
    durationMs: results.durationMs,
  })

  return results
}

// ─── Stats ──────────────────────────────────────────────────────────────

async function getConsolidationStats() {
  const toInt = v => v?.toInt?.() ?? v ?? 0

  const [synthCount] = await runQuery(`MATCH (n) WHERE n.is_synthesized = true RETURN count(n) AS c`)
  const [inferredRels] = await runQuery(`MATCH ()-[r]->() WHERE r.inferred = true RETURN count(r) AS c`)
  const [staleCount] = await runQuery(`MATCH (n) WHERE n.stale_since IS NOT NULL RETURN count(n) AS c`)
  const [mergedCount] = await runQuery(`
    MATCH (n) WHERE n.merged_from IS NOT NULL
    RETURN count(n) AS c, reduce(total = 0, x IN collect(size(n.merged_from)) | total + x) AS totalMerged
  `)
  const [narrativeCount] = await runQuery(`MATCH (n:Narrative) RETURN count(n) AS c`)
  const [predictionCount] = await runQuery(`MATCH (n:Prediction) RETURN count(n) AS c`)
  const [episodeCount] = await runQuery(`MATCH (n:Episode) RETURN count(n) AS c`)
  const [contradictionCount] = await runQuery(`MATCH ()-[r:CONTRADICTS|SUPERSEDES|REFINES]->() RETURN count(r) AS c`)
  const [insightCount] = await runQuery(`MATCH (n:Insight) RETURN count(n) AS c`)
  const [freeAssocRels] = await runQuery(`MATCH ()-[r]->() WHERE r.discovered_by = 'free_association' RETURN count(r) AS c`)
  const [avgImportance] = await runQuery(`
    MATCH (n) WHERE n.importance IS NOT NULL
    RETURN round(avg(n.importance) * 1000) / 1000.0 AS avg, max(n.importance) AS max
  `)

  return {
    synthesizedPatterns: toInt(synthCount?.get('c')),
    inferredRelationships: toInt(inferredRels?.get('c')),
    staleNodes: toInt(staleCount?.get('c')),
    mergedNodes: toInt(mergedCount?.get('c')),
    totalMerged: toInt(mergedCount?.get('totalMerged')),
    narratives: toInt(narrativeCount?.get('c')),
    predictions: toInt(predictionCount?.get('c')),
    episodes: toInt(episodeCount?.get('c')),
    contradictions: toInt(contradictionCount?.get('c')),
    insights: toInt(insightCount?.get('c')),
    freeAssociationEdges: toInt(freeAssocRels?.get('c')),
    avgImportance: avgImportance?.get('avg') ?? 0,
    maxImportance: avgImportance?.get('max') ?? 0,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeLabel(label) {
  return label.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'Unknown'
}

// Parse a free-form timeframe string into an expiry duration (days).
// The AI can now return any timeframe description — we extract the number if present,
// otherwise fall back to keyword hints, otherwise 60 days.
function estimateTimeframeDays(timeframe) {
  if (!timeframe) return 60
  const s = String(timeframe).toLowerCase()
  // Extract a number if present (e.g. "3 weeks", "~2 months", "10 days")
  const numMatch = s.match(/(\d+(?:\.\d+)?)\s*(day|week|month|year)/)
  if (numMatch) {
    const n = parseFloat(numMatch[1])
    const unit = numMatch[2]
    if (unit === 'day') return Math.round(n)
    if (unit === 'week') return Math.round(n * 7)
    if (unit === 'month') return Math.round(n * 30)
    if (unit === 'year') return Math.round(n * 365)
  }
  // Keyword fallback
  if (s.includes('today') || s.includes('immediate') || s.includes('hour')) return 2
  if (s.includes('day')) return 7
  if (s.includes('week')) return 30
  if (s.includes('month')) return 90
  if (s.includes('year') || s.includes('quarter')) return 120
  return 60
}

function parseJSON(content) {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse consolidation response: ${content.slice(0, 200)}`)
  }
}

// ─── Consolidation Director ───────────────────────────────────────────
//
// Replaces the hardcoded 10-phase sequential pipeline.
//
// The Director reads the current graph state and asks: what does this
// graph actually need right now? It selects and orders phases based on
// what it observes — not based on what number comes next in a list.
//
// It uses DeepSeek to interpret the graph state signal and decide.
// The phases themselves are unchanged — they're good. What changes is
// who decides when to run them.
//
// The old `runConsolidationPipeline` remains available for direct calls
// (e.g. from tests or API triggers). The Director is the new default.

async function runConsolidationDirector({ dryRun = false } = {}) {
  logger.info('KG ConsolidationDirector: reading graph state...')
  const directorStart = Date.now()

  // 1. Read the graph state — what's there and what hasn't been processed
  const graphState = await readGraphState()

  // 2. Ask DeepSeek: given this state, what synthesis work is most needed?
  const workPlan = await directConsolidation(graphState)

  logger.info(`KG ConsolidationDirector: plan — ${workPlan.map(p => p.phase).join(', ')}`)

  // 3. Execute exactly what was decided, in the decided order
  const results = { directed: true, plan: workPlan, phases: {}, durationMs: 0 }

  function emitPhase(eventType, data = {}) {
    try {
      const eventBus = require('./internalEventBusService')
      eventBus.emit(eventType, data)
    } catch {}
  }

  const PHASE_MAP = {
    deduplicate:  () => deduplicateNodes({ dryRun }),
    abstract:     () => synthesizePatterns({ dryRun }),
    thread:       () => threadCausalChains({ dryRun }),
    validate:     () => validateInferredEdges({ dryRun }),
    contradict:   () => detectContradictions({ dryRun }),
    narrate:      () => synthesizeNarratives({ dryRun }),
    predict:      () => generatePredictions({ dryRun }),
    score:        () => scoreImportance({ dryRun }),
    episodic:     () => buildEpisodes({ dryRun }),
    free_associate: () => freeAssociate({ dryRun }),
    decay:        () => decayStaleNodes({ dryRun }),
  }

  for (const step of workPlan) {
    const fn = PHASE_MAP[step.phase]
    if (!fn) {
      logger.warn(`KG Director: unknown phase "${step.phase}" — skipping`)
      continue
    }

    try {
      logger.info(`KG Director: running ${step.phase} — ${step.reason}`)
      const result = await fn()
      results.phases[step.phase] = result
      emitPhase(`kg:phase_complete`, { phase: step.phase, reason: step.reason })
    } catch (err) {
      logger.error(`KG Director: phase "${step.phase}" failed`, { error: err.message })
      results.phases[step.phase] = { error: err.message }
    }
  }

  results.durationMs = Date.now() - directorStart

  emitPhase('kg:consolidation_complete', {
    directed: true,
    phases: workPlan.map(p => p.phase),
    durationMs: results.durationMs,
  })

  logger.info(`KG ConsolidationDirector: complete in ${results.durationMs}ms`, {
    phasesRun: workPlan.length,
    phases: workPlan.map(p => p.phase),
  })

  return results
}

async function readGraphState() {
  const state = {}

  await Promise.allSettled([
    runQuery(`MATCH (n) RETURN count(n) AS total`).then(([r]) => {
      state.totalNodes = r?.get('total')?.toInt?.() ?? 0
    }),

    runQuery(`
      MATCH (n)
      RETURN
        count(CASE WHEN n.embedding IS NULL THEN n END) AS unembedded,
        count(CASE WHEN n.is_synthesized = true THEN n END) AS synthesized,
        count(CASE WHEN n.importance IS NULL THEN n END) AS unscored,
        count(CASE WHEN n.stale_since IS NOT NULL THEN n END) AS stale
    `).then(([r]) => {
      state.unembedded = r?.get('unembedded')?.toInt?.() ?? 0
      state.synthesized = r?.get('synthesized')?.toInt?.() ?? 0
      state.unscored = r?.get('unscored')?.toInt?.() ?? 0
      state.stale = r?.get('stale')?.toInt?.() ?? 0
    }).catch(() => {}),

    runQuery(`MATCH ()-[r]->() RETURN count(r) AS total, count(CASE WHEN r.inferred = true THEN r END) AS inferred`).then(([r]) => {
      state.totalRelationships = r?.get('total')?.toInt?.() ?? 0
      state.inferredRelationships = r?.get('inferred')?.toInt?.() ?? 0
    }).catch(() => {}),

    runQuery(`MATCH (n:Narrative) RETURN count(n) AS c`).then(([r]) => {
      state.narratives = r?.get('c')?.toInt?.() ?? 0
    }).catch(() => {}),

    runQuery(`MATCH (n:Prediction) RETURN count(n) AS c`).then(([r]) => {
      state.predictions = r?.get('c')?.toInt?.() ?? 0
    }).catch(() => {}),

    runQuery(`MATCH (n:Episode) RETURN count(n) AS c`).then(([r]) => {
      state.episodes = r?.get('c')?.toInt?.() ?? 0
    }).catch(() => {}),

    // Nodes with many connections but no synthesis (abstraction candidates)
    runQuery(`
      MATCH (n)
      WHERE n.is_synthesized IS NULL OR n.is_synthesized = false
      WITH n, size((n)--()) AS degree
      WHERE degree >= 5
      RETURN count(n) AS hubs
    `).then(([r]) => {
      state.unsynthesizedHubs = r?.get('hubs')?.toInt?.() ?? 0
    }).catch(() => {}),

    // People/Projects without narratives
    // NARRATES is the rel type created by synthesizeNarratives() — Narrative-[NARRATES]->Subject
    runQuery(`
      MATCH (n)
      WHERE any(lbl IN labels(n) WHERE lbl IN ['Person', 'Project', 'Organisation'])
        AND NOT ()-[:NARRATES]->(n)
      RETURN count(n) AS c
    `).then(([r]) => {
      state.entitiesWithoutNarrative = r?.get('c')?.toInt?.() ?? 0
    }).catch(() => {}),

    // Recent ingestions (last 24h) — freshness signal
    runQuery(`
      MATCH (n) WHERE n.created_at > datetime() - duration('PT24H')
      RETURN count(n) AS recent
    `).then(([r]) => {
      state.recentIngestions = r?.get('recent')?.toInt?.() ?? 0
    }).catch(() => {}),
  ])

  return state
}

async function directConsolidation(graphState) {
  const deepseekService = require('./deepseekService')
  const pressure = (() => {
    try { return require('./metabolismBridgeService').getPressure() } catch { return 0.3 }
  })()

  const stateDesc = [
    `Total nodes: ${graphState.totalNodes}`,
    `Unembedded: ${graphState.unembedded}`,
    `Synthesized patterns: ${graphState.synthesized}`,
    `Unscored nodes: ${graphState.unscored}`,
    `Stale nodes: ${graphState.stale}`,
    `Inferred relationships: ${graphState.inferredRelationships}`,
    `Narratives: ${graphState.narratives}`,
    `Predictions: ${graphState.predictions}`,
    `Episodes: ${graphState.episodes}`,
    `Unsynthesized hubs (≥5 connections): ${graphState.unsynthesizedHubs}`,
    `Entities without narrative: ${graphState.entitiesWithoutNarrative}`,
    `Recent ingestions (24h): ${graphState.recentIngestions}`,
    `Metabolic pressure: ${pressure.toFixed(2)}`,
  ].join('\n')

  const systemPrompt = `Knowledge graph consolidation planning.

Available phases: deduplicate, abstract, thread, validate, contradict, narrate, predict, score, episodic, free_associate, decay.

Given the graph state and metabolic pressure, decide which phases to run, in what order, and why. Return a JSON array of { phase, reason } objects in execution order.`

  try {
    const raw = await deepseekService.callDeepSeek(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Current graph state:\n${stateDesc}\n\nWhat should this consolidation run do?` },
      ],
      { module: 'kg_consolidation_director', skipRetrieval: true, skipLogging: true }
    )

    const parsed = (() => {
      try {
        const s = raw.trim()
        const jsonStr = s.startsWith('[') ? s : s.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] || s
        return JSON.parse(jsonStr)
      } catch { return null }
    })()

    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.filter(p => p.phase && typeof p.phase === 'string')
    }
  } catch (err) {
    logger.warn('KG Director: DeepSeek call failed — using heuristic plan', { error: err.message })
  }

  // Heuristic fallback — if the mind is unreachable
  return buildHeuristicPlan(graphState, pressure)
}

function buildHeuristicPlan(state, pressure) {
  const plan = []

  if (pressure > 0.7) {
    // Survival mode: only essential maintenance
    if ((state.stale || 0) > 30) plan.push({ phase: 'decay', reason: 'High stale count under pressure' })
    if ((state.unscored || 0) > 50) plan.push({ phase: 'score', reason: 'Many unscored nodes' })
    return plan
  }

  // Normal operation: signal-driven
  if ((state.totalNodes || 0) > 0) plan.push({ phase: 'deduplicate', reason: 'Baseline deduplication' })
  if ((state.unsynthesizedHubs || 0) > 5) plan.push({ phase: 'abstract', reason: `${state.unsynthesizedHubs} hub nodes lack synthesis` })
  if ((state.entitiesWithoutNarrative || 0) > 3) plan.push({ phase: 'narrate', reason: `${state.entitiesWithoutNarrative} entities lack narrative arcs` })
  if ((state.unscored || 0) > 20) plan.push({ phase: 'score', reason: `${state.unscored} unscored nodes` })
  if ((state.stale || 0) > 20) plan.push({ phase: 'decay', reason: `${state.stale} stale nodes` })

  return plan.slice(0, 5)
}

// ─── Helper Counts (used by workers for adaptive scheduling) ──────────

async function countStaleNodes() {
  const [result] = await runQuery(
    `MATCH (n) WHERE n.stale_since IS NOT NULL RETURN count(n) AS cnt`
  )
  return result?.get('cnt')?.toInt?.() ?? result?.get('cnt') ?? 0
}

async function countDedupCandidates() {
  const [result] = await runQuery(
    `MATCH (a), (b)
     WHERE elementId(a) < elementId(b)
       AND labels(a) = labels(b)
       AND toLower(trim(a.name)) = toLower(trim(b.name))
       AND a.name <> b.name
     RETURN count(*) AS cnt
     LIMIT 1`
  ).catch(() => [{ get: () => 0 }])
  return result?.get('cnt')?.toInt?.() ?? result?.get('cnt') ?? 0
}

module.exports = {
  // Individual phases (still available for direct/targeted use)
  deduplicateNodes,
  synthesizePatterns,
  threadCausalChains,
  validateInferredEdges,
  detectContradictions,
  synthesizeNarratives,
  generatePredictions,
  scoreImportance,
  buildEpisodes,
  freeAssociate,
  decayStaleNodes,

  // The Director — reads the graph, decides what to run (new default)
  runConsolidationPipeline: runConsolidationDirector,

  // Legacy: the full sequential pipeline (all phases, hardcoded order)
  runFullPipeline: runConsolidationPipeline,

  getConsolidationStats,
  countStaleNodes,
  countDedupCandidates,
}
