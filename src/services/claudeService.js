const Anthropic = require('@anthropic-ai/sdk')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE SERVICE — Direct Anthropic API
//
// Single LLM layer for all background/service-level AI calls.
// Uses the same ANTHROPIC_API_KEY as the OS Session.
// Haiku by default (fast + cheap for mechanical tasks).
// Pass model: 'claude-sonnet-4-6' for anything needing more reasoning.
// ═══════════════════════════════════════════════════════════════════════

// Sonnet is the default: strong enough for reasoning, triage, code review.
// Pass model: 'claude-haiku-4-5-20251001' explicitly for mechanical/high-volume tasks.
const DEFAULT_MODEL = 'claude-sonnet-4-6'
const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000

let _client = null
function getClient() {
  if (!_client) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set')
    _client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
  }
  return _client
}

// ─── Core call ────────────────────────────────────────────────────────

async function callClaude(messages, {
  module = 'general',
  model = DEFAULT_MODEL,
  system = null,
  maxTokens = 4096,
  temperature = null,
} = {}) {
  const client = getClient()
  const start = Date.now()

  // Separate system messages from the array if mixed in
  const systemParts = []
  const nonSystem = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
    else nonSystem.push(m)
  }
  if (system) systemParts.unshift(system)
  const systemPrompt = systemParts.length > 0 ? systemParts.join('\n\n') : undefined

  let response
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      response = await client.messages.create({
        model,
        max_tokens: maxTokens,
        ...(systemPrompt && { system: systemPrompt }),
        messages: nonSystem,
        ...(temperature !== null && { temperature }),
      })
      break
    } catch (err) {
      const status = err.status || err.response?.status
      const retryable = !status || status === 429 || status >= 500
      if (!retryable || attempt === MAX_RETRIES - 1) throw err
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.random() * 500
      logger.debug(`Claude retry ${attempt + 1}/${MAX_RETRIES} after ${status || 'error'} (${Math.round(delay)}ms)`, { module })
      await new Promise(r => setTimeout(r, delay))
    }
  }

  const durationMs = Date.now() - start
  const textBlocks = (response.content || []).filter(b => b.type === 'text')
  if (!textBlocks.length) throw new Error(`Claude returned empty response (module: ${module})`)
  const content = textBlocks.map(b => b.text).join('\n')

  // Track usage in claude_usage table (same table OS Session uses)
  const inputTokens = response.usage?.input_tokens || 0
  const outputTokens = response.usage?.output_tokens || 0
  db`
    INSERT INTO claude_usage (source, provider, model, input_tokens, output_tokens, week_start)
    VALUES (${module}, 'anthropic', ${model}, ${inputTokens}, ${outputTokens},
            date_trunc('week', now()))
    ON CONFLICT DO NOTHING
  `.catch(() => {})

  if (response.stop_reason === 'max_tokens') {
    logger.warn(`Claude response truncated (module: ${module})`, { contentLength: content.length })
  }

  return content
}

// ─── JSON helper — parses response, retries once on parse failure ─────

async function callClaudeJSON(messages, opts = {}) {
  const raw = await callClaude(messages, opts)
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    // Strip any leading/trailing non-JSON prose and retry parse
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]) } catch {}
    }
    logger.debug(`Claude JSON parse failed (module: ${opts.module || 'general'})`, { raw: raw.slice(0, 200) })
    throw new Error(`Claude returned non-JSON response for module ${opts.module || 'general'}`)
  }
}

module.exports = { callClaude, callClaudeJSON }
