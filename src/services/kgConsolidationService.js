const { runQuery, runWrite } = require('../config/neo4j')
const logger = require('../config/logger')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// KNOWLEDGE GRAPH MEMORY CONSOLIDATION
//
// Transforms working memories into long-term knowledge through four
// phases modeled on biological memory consolidation:
//
//   1. DEDUPLICATE  — Merge near-identical nodes (same entity, different mentions)
//   2. ABSTRACT     — Synthesize higher-order patterns from clusters
//   3. THREAD       — Discover causal/temporal chains between events
//   4. DECAY        — Prune disconnected, stale, low-value noise
//
// Each phase is independently runnable. The full pipeline runs nightly.
// Every consolidation action is logged so the graph's evolution is auditable.
// ═══════════════════════════════════════════════════════════════════════

// ─── Phase 1: Deduplication ─────────────────────────────────────────────

async function deduplicateNodes({ dryRun = false } = {}) {
  const merged = []

  // Strategy 1: Exact name match after normalization (case, whitespace, punctuation)
  const exactDupes = await runQuery(`
    MATCH (a), (b)
    WHERE elementId(a) < elementId(b)
      AND labels(a) = labels(b)
      AND apoc.text.clean(a.name) = apoc.text.clean(b.name)
    RETURN elementId(a) AS keepId, a.name AS keepName,
           elementId(b) AS dupeId, b.name AS dupeName,
           labels(a) AS labels
    LIMIT 50
  `).catch(() => [])

  // Fallback if APOC isn't available — use toLower + trim
  let dupes = exactDupes
  if (exactDupes.length === 0) {
    dupes = await runQuery(`
      MATCH (a), (b)
      WHERE elementId(a) < elementId(b)
        AND labels(a) = labels(b)
        AND toLower(trim(a.name)) = toLower(trim(b.name))
        AND a.name <> b.name
      RETURN elementId(a) AS keepId, a.name AS keepName,
             elementId(b) AS dupeId, b.name AS dupeName,
             labels(a) AS labels
      LIMIT 50
    `)
  }

  // Strategy 2: Embedding similarity for nodes with the same label
  const embeddingDupes = await runQuery(`
    MATCH (a), (b)
    WHERE elementId(a) < elementId(b)
      AND labels(a) = labels(b)
      AND a.embedding IS NOT NULL
      AND b.embedding IS NOT NULL
      AND a.name <> b.name
      AND gds.similarity.cosine(a.embedding, b.embedding) > 0.95
    WITH a, b
    OPTIONAL MATCH (a)--(shared)--(b)
    WITH a, b, count(shared) AS sharedNeighbors
    WHERE sharedNeighbors > 0
    RETURN elementId(a) AS keepId, a.name AS keepName,
           elementId(b) AS dupeId, b.name AS dupeName,
           labels(a) AS labels, sharedNeighbors
    LIMIT 30
  `).catch(() => []) // GDS may not be available on Aura free tier

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
        content: `You are a knowledge graph analyst. A node "${hubName}" has ${targets.length} "${relType}" relationships pointing to: ${targets.join(', ')}.

What higher-order pattern, theme, or strategic direction does this cluster represent? Respond with JSON only:
{
  "theme_name": "concise name for the pattern (5 words max)",
  "theme_label": "Strategic_Direction|Recurring_Pattern|Emerging_Trend|Decision_Pattern|Behavioral_Pattern",
  "description": "one sentence explaining what this pattern means",
  "confidence": 0.0-1.0,
  "causal_insight": "what this pattern suggests about future direction or underlying motivation"
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.theme_name || parsed.confidence < 0.6) continue

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
        content: `Two entities "${nameA}" and "${nameB}" share ${sharedNames.length} connections: ${sharedNames.join(', ')}.

What is the nature of the relationship between these two entities, given their shared connections? Respond with JSON only:
{
  "relationship_type": "SCREAMING_SNAKE_CASE verb describing the relationship",
  "description": "one sentence",
  "confidence": 0.0-1.0
}`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.relationship_type || parsed.confidence < 0.6) continue

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
        content: `In a knowledge graph, "${earlier}" occurred before "${later}", connected through "${via}".

Is there a causal or evolutionary relationship? Respond with JSON only:
{
  "relationship": "CAUSED|PRECEDED|EVOLVED_INTO|LED_TO|ENABLED|BLOCKED|null",
  "description": "one sentence explaining the causal link",
  "confidence": 0.0-1.0
}

If there's no meaningful causal link, set relationship to null.`
      }], { module: 'kg_consolidation', skipRetrieval: true, skipLogging: true })

      const parsed = parseJSON(response)
      if (!parsed.relationship || parsed.confidence < 0.65) continue

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

// ─── Phase 4: Decay ─────────────────────────────────────────────────────

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
    decay: { flagged: 0, pruned: 0 },
    durationMs: 0,
  }

  try {
    results.dedup = await deduplicateNodes({ dryRun })
  } catch (err) {
    logger.error('KG consolidation phase 1 (dedup) failed', { error: err.message })
  }

  try {
    results.patterns = await synthesizePatterns({ dryRun })
  } catch (err) {
    logger.error('KG consolidation phase 2 (patterns) failed', { error: err.message })
  }

  try {
    results.causal = await threadCausalChains({ dryRun })
  } catch (err) {
    logger.error('KG consolidation phase 3 (causal) failed', { error: err.message })
  }

  try {
    results.decay = await decayStaleNodes({ dryRun })
  } catch (err) {
    logger.error('KG consolidation phase 4 (decay) failed', { error: err.message })
  }

  results.durationMs = Date.now() - start

  logger.info('KG consolidation pipeline complete', {
    merged: results.dedup.length,
    patterns: results.patterns.length,
    causalThreads: results.causal.length,
    flaggedStale: results.decay.flagged,
    pruned: results.decay.pruned,
    durationMs: results.durationMs,
  })

  return results
}

// ─── Stats ──────────────────────────────────────────────────────────────

async function getConsolidationStats() {
  const [synthCount] = await runQuery(`
    MATCH (n) WHERE n.is_synthesized = true
    RETURN count(n) AS count
  `)
  const [inferredRels] = await runQuery(`
    MATCH ()-[r]->() WHERE r.inferred = true
    RETURN count(r) AS count
  `)
  const [staleCount] = await runQuery(`
    MATCH (n) WHERE n.stale_since IS NOT NULL
    RETURN count(n) AS count
  `)
  const [mergedCount] = await runQuery(`
    MATCH (n) WHERE n.merged_from IS NOT NULL
    RETURN count(n) AS count, reduce(total = 0, x IN collect(size(n.merged_from)) | total + x) AS totalMerged
  `)

  return {
    synthesizedPatterns: synthCount?.get('count')?.toInt?.() ?? 0,
    inferredRelationships: inferredRels?.get('count')?.toInt?.() ?? 0,
    staleNodes: staleCount?.get('count')?.toInt?.() ?? 0,
    mergedNodes: mergedCount?.get('count')?.toInt?.() ?? 0,
    totalMerged: mergedCount?.get('totalMerged')?.toInt?.() ?? 0,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

function sanitizeLabel(label) {
  return label.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'Unknown'
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

module.exports = {
  deduplicateNodes,
  synthesizePatterns,
  threadCausalChains,
  decayStaleNodes,
  runConsolidationPipeline,
  getConsolidationStats,
}
