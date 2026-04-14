const logger = require('../config/logger')
const db = require('../config/db')
const factoryBridge = require('./factoryBridge')

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE SERVICE — dispatches background LLM calls to the factory process.
//
// Chat stays in ecodia-api with its own credentials (~/.claude).
// Everything else (KG consolidation, goal scoring, gmail triage, etc.) goes
// here. We publish a dispatch to ecodia-factory over Redis; the factory
// spawns a short-lived `claude --print` subprocess with its own
// credentials dir (~/.claude-bg / CLAUDE_CONFIG_DIR_BG) and returns the
// result. Zero chance of racing chat OAuth.
//
// Signature kept identical so old callers don't change: callClaude returns
// a string; callClaudeJSON returns a parsed object.
// ═══════════════════════════════════════════════════════════════════════

async function callClaude(messages, { module: mod = 'general', system = null } = {}) {
  const start = Date.now()

  // Flatten messages into a single prompt. Preserves the old behaviour:
  // system content goes first, then user/assistant turns in order.
  const systemParts = []
  const conversationParts = []
  for (const m of messages) {
    if (m.role === 'system') systemParts.push(m.content)
    else if (m.role === 'user') conversationParts.push(m.content)
    else if (m.role === 'assistant') conversationParts.push(`[Previous response]: ${m.content}`)
  }
  if (system) systemParts.unshift(system)

  const prompt = [
    ...(systemParts.length ? [`<system>\n${systemParts.join('\n\n')}\n</system>\n`] : []),
    ...conversationParts,
  ].join('\n\n')

  const content = await factoryBridge.runBackgroundJob(prompt, { module: mod })

  const durationMs = Date.now() - start
  logger.debug(`callClaude via factory bridge (${mod})`, { durationMs, contentLength: content.length })

  db`
    INSERT INTO claude_usage (source, provider, model, input_tokens, output_tokens, week_start)
    VALUES (${mod}, 'factory-bg', 'sonnet', ${Math.ceil(prompt.length / 4)}, ${Math.ceil(content.length / 4)},
            date_trunc('week', now()))
    ON CONFLICT DO NOTHING
  `.catch(() => {})

  return content
}

// ─── JSON helper — parses response, retries once on parse failure ─────

async function callClaudeJSON(messages, opts = {}) {
  const augmentedMessages = [...messages]
  const lastIdx = augmentedMessages.length - 1
  if (lastIdx >= 0 && augmentedMessages[lastIdx].role === 'user') {
    augmentedMessages[lastIdx] = {
      ...augmentedMessages[lastIdx],
      content: augmentedMessages[lastIdx].content + '\n\nRespond with valid JSON only. No markdown, no explanation.',
    }
  }

  const raw = await callClaude(augmentedMessages, opts)
  const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  try {
    return JSON.parse(cleaned)
  } catch {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
    if (jsonMatch) {
      try { return JSON.parse(jsonMatch[0]) } catch {}
    }
    logger.debug(`Claude JSON parse failed (module: ${opts.module || 'general'})`, { raw: raw.slice(0, 200) })
    throw new Error(`Claude returned non-JSON response for module ${opts.module || 'general'}`)
  }
}

module.exports = { callClaude, callClaudeJSON }
