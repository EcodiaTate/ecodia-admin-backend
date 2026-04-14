const logger = require('../config/logger')
const db = require('../config/db')

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE SERVICE — routes through the single OS session subprocess.
//
// History:
//   * Originally used direct Anthropic API (ANTHROPIC_API_KEY).
//   * Switched Apr 14 2026 to spawn `claude --print` (Max plan, no API key).
//   * That caused parallel subprocesses across PM2 workers to race for the
//     shared OAuth credentials file. Refresh-token rotation invalidated
//     in-flight tokens → "(processing...)" hangs.
//   * Now (Apr 14 2026, same day) every background LLM call queues through
//     osSessionService.sendTask, which serialises them with user chat via
//     the existing _sendQueue. Exactly one `claude` subprocess lives on
//     the VPS at any moment. Max plan, no races, no API key.
//
// Signature kept identical so callers don't change: callClaude(messages, opts)
// returns a string; callClaudeJSON returns a parsed object.
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

  // Lazy require to avoid circular dependency (osSessionService pulls in
  // secretSafetyService which may be required before this module is loaded).
  const osSession = require('./osSessionService')
  const content = await osSession.sendTask(prompt, { module: mod })

  const durationMs = Date.now() - start
  logger.debug(`callClaude complete via OS session (${mod})`, { durationMs, contentLength: content.length })

  // Approximate usage tracking. We no longer know the real model — the OS
  // session picks it. Record a flat "os-session" provider so this stays
  // informative without lying.
  db`
    INSERT INTO claude_usage (source, provider, model, input_tokens, output_tokens, week_start)
    VALUES (${mod}, 'os-session', 'os-session', ${Math.ceil(prompt.length / 4)}, ${Math.ceil(content.length / 4)},
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
