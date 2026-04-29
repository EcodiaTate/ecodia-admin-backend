/**
 * Laptop Vision proxy — /api/laptop-vision/locate (+ /cache/*)
 *
 * The eos-laptop-agent does NOT hold an Anthropic credential. It POSTs
 * { screenshot_base64, target, expected_count? } here, and we proxy to
 * the Anthropic messages API using the conductor's existing OAuth token
 * (CLAUDE_CODE_OAUTH_TOKEN_TATE). Returns structured matches:
 *   { matches: [{ x, y, confidence, bbox, label }], ambiguous: bool }
 *
 * Cache (added by fork_mojvibbw_f82adc, 29 Apr 2026): the agent's
 * vision.click primitive uses /cache/get + /cache/set to avoid re-running
 * the vision proxy for repeated locator queries on the same URL+viewport.
 * Storage is kv_store rows under namespace `macros.vision_cache.<sha1>`.
 *
 * Vision-first macro doctrine prerequisite. Shipped 29 Apr 2026 as part
 * of the macros vision-first primitives wave (fork_mojs0mm2_79180b).
 */
const express = require('express')
const router = express.Router()
const logger = require('../config/logger')
const env = require('../config/env')
const db = require('../config/db')

// Use OAuth bearer (Claude Max account) - same auth pattern as
// usageEnergyService.js. Vision content blocks are supported by the
// Messages API regardless of bearer auth path.
function pickOAuthToken() {
  return process.env.CLAUDE_CODE_OAUTH_TOKEN_CODE
      || process.env.CLAUDE_CODE_OAUTH_TOKEN_TATE
      || env.ANTHROPIC_API_KEY
      || null
}

// Vision model. Sonnet 4.6 is current default for any rich
// structured-output task; haiku is too lossy for bbox extraction.
const VISION_MODEL = process.env.LAPTOP_VISION_MODEL || 'claude-sonnet-4-6'

const SYSTEM_PROMPT = `You are a UI element locator. The user gives you a full-screen screenshot from a Windows desktop and a natural-language description of a UI target. Return a JSON object describing where the target is on screen.

Output schema:
{
  "matches": [
    {
      "x": <integer center-x in screen pixels>,
      "y": <integer center-y in screen pixels>,
      "bbox": { "x": <left>, "y": <top>, "w": <width>, "h": <height> },
      "confidence": <number 0-1>,
      "label": "<short human-readable label of what was matched>"
    }
  ],
  "ambiguous": <bool - true if multiple plausible candidates and you cannot pick one with confidence>,
  "reasoning": "<one short sentence on what you saw and why you picked these matches>"
}

Rules:
- Coordinates are in screen pixels of the screenshot's native resolution. Top-left is (0,0).
- If you can confidently identify ONE target, return one match with confidence > 0.8.
- If you can see two or more equally plausible candidates, return all of them with confidence between 0.3 and 0.7 and set ambiguous=true.
- If you cannot find anything matching the description, return matches=[] and ambiguous=false.
- Never return prose outside the JSON object. JSON only.`

router.post('/locate', async (req, res) => {
  try {
    const { screenshot_base64, target, expected_count } = req.body || {}
    if (!screenshot_base64) return res.status(400).json({ error: 'screenshot_base64 required' })
    if (!target || typeof target !== 'string') return res.status(400).json({ error: 'target (string) required' })

    const oauthToken = pickOAuthToken()
    if (!oauthToken) {
      return res.status(503).json({ error: 'No vision credential available — neither CLAUDE_CODE_OAUTH_TOKEN_* nor ANTHROPIC_API_KEY in env' })
    }

    const userPrompt = expected_count
      ? `Target: "${target}". Expected count: ${expected_count}. Return JSON only.`
      : `Target: "${target}". Return JSON only.`

    const body = {
      model: VISION_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: screenshot_base64 } },
            { type: 'text', text: userPrompt },
          ],
        },
      ],
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 30_000)

    let resp
    try {
      resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${oauthToken}`,
          'Content-Type': 'application/json',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeoutId)
    }

    const text = await resp.text()
    if (!resp.ok) {
      logger.warn('laptop-vision: Anthropic API non-OK', { status: resp.status, body: text.slice(0, 500) })
      return res.status(502).json({ error: 'Vision API call failed', status: resp.status, detail: text.slice(0, 500) })
    }

    let parsed
    try { parsed = JSON.parse(text) } catch { return res.status(502).json({ error: 'Vision API returned non-JSON envelope', detail: text.slice(0, 500) }) }

    const contentBlocks = parsed?.content || []
    const textBlock = contentBlocks.find(b => b.type === 'text')
    if (!textBlock) return res.status(502).json({ error: 'Vision API returned no text block', detail: parsed })

    let structured
    const cleaned = String(textBlock.text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    try {
      structured = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) return res.status(502).json({ error: 'Vision response not parseable as JSON', raw: cleaned.slice(0, 500) })
      try { structured = JSON.parse(m[0]) } catch (err) {
        return res.status(502).json({ error: 'Vision response JSON.parse failed', raw: cleaned.slice(0, 500), detail: err.message })
      }
    }

    if (!Array.isArray(structured.matches)) structured.matches = []
    if (typeof structured.ambiguous !== 'boolean') structured.ambiguous = structured.matches.length > 1

    res.json(structured)
  } catch (err) {
    logger.error('laptop-vision: handler error', { error: err.message, stack: err.stack })
    res.status(500).json({ error: err.message })
  }
})

// ─────────────────────────────────────────────────────────────────────
// Vision cache routes — kv_store namespace `macros.vision_cache.<sha1>`
//
// The agent's vision.click primitive uses these to avoid re-querying the
// (slow, $$$) vision proxy on repeat-locates of the same target on the
// same URL + viewport. Cache invalidation is TTL-based; a stale row is
// also rejected at GET time if observed_at + ttl_s < now.
// ─────────────────────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'macros.vision_cache.'

// GET /api/laptop-vision/cache/:cache_key — returns { hit, entry?, age_s? }
router.get('/cache/:cache_key', async (req, res) => {
  try {
    const key = CACHE_KEY_PREFIX + req.params.cache_key
    const rows = await db`SELECT value FROM kv_store WHERE key = ${key}`
    if (!rows.length) return res.json({ hit: false })

    const raw = rows[0].value
    const entry = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!entry || !entry.observed_at) return res.json({ hit: false })

    const ageMs = Date.now() - new Date(entry.observed_at).getTime()
    const ttlMs = (entry.ttl_s || 300) * 1000
    if (ageMs > ttlMs) return res.json({ hit: false, expired: true, age_s: Math.round(ageMs / 1000) })

    res.json({ hit: true, entry, age_s: Math.round(ageMs / 1000) })
  } catch (err) {
    logger.error('laptop-vision/cache GET error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/laptop-vision/cache/:cache_key — body { entry }
router.put('/cache/:cache_key', async (req, res) => {
  try {
    const key = CACHE_KEY_PREFIX + req.params.cache_key
    const { entry } = req.body || {}
    if (!entry || typeof entry !== 'object') {
      return res.status(400).json({ error: 'entry (object) required' })
    }
    // Stamp observed_at if caller didn't
    if (!entry.observed_at) entry.observed_at = new Date().toISOString()
    if (!entry.hit_count) entry.hit_count = 0
    entry.last_used_at = new Date().toISOString()

    await db`
      INSERT INTO kv_store (key, value)
      VALUES (${key}, ${JSON.stringify(entry)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
    `
    res.json({ ok: true, key: req.params.cache_key })
  } catch (err) {
    logger.error('laptop-vision/cache PUT error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/laptop-vision/cache — body { pattern? } clears all when no pattern
router.delete('/cache', async (req, res) => {
  try {
    const { pattern } = req.body || {}
    let result
    if (pattern && typeof pattern === 'string') {
      // pattern is matched against the suffix (after the namespace prefix)
      const sqlPattern = CACHE_KEY_PREFIX + '%' + pattern + '%'
      result = await db`DELETE FROM kv_store WHERE key LIKE ${sqlPattern}`
    } else {
      const sqlPattern = CACHE_KEY_PREFIX + '%'
      result = await db`DELETE FROM kv_store WHERE key LIKE ${sqlPattern}`
    }
    res.json({ ok: true, cleared: result.count || 0 })
  } catch (err) {
    logger.error('laptop-vision/cache DELETE error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

// GET /api/laptop-vision/cache-stats — aggregate observability
router.get('/cache-stats', async (req, res) => {
  try {
    const sqlPattern = CACHE_KEY_PREFIX + '%'
    const rows = await db`SELECT key, value, updated_at FROM kv_store WHERE key LIKE ${sqlPattern}`
    let total = 0
    let stale = 0
    let totalHits = 0
    const targets = {}
    for (const row of rows) {
      total++
      const v = typeof row.value === 'string' ? JSON.parse(row.value) : row.value
      const ageMs = Date.now() - new Date(v.observed_at || row.updated_at).getTime()
      const ttlMs = (v.ttl_s || 300) * 1000
      if (ageMs > ttlMs) stale++
      totalHits += (v.hit_count || 0)
      const t = v.target_descriptor || 'unknown'
      targets[t] = (targets[t] || 0) + 1
    }
    res.json({
      total_entries: total,
      stale_entries: stale,
      live_entries: total - stale,
      total_hit_count: totalHits,
      top_targets: Object.entries(targets).sort((a, b) => b[1] - a[1]).slice(0, 10),
    })
  } catch (err) {
    logger.error('laptop-vision/cache-stats error', { error: err.message })
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
