const { spawn } = require('child_process')
const logger = require('../config/logger')
const db = require('../config/db')

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE SERVICE — Uses Claude Code CLI (Max plan)
//
// Single LLM layer for all background/service-level AI calls.
// Calls `claude --print` which uses the Max subscription directly.
// No API key needed. No separate billing.
//
// Previous version used direct Anthropic API (ANTHROPIC_API_KEY).
// Switched Apr 14 2026 to use Max plan via CLI instead.
// ═══════════════════════════════════════════════════════════════════════

const DEFAULT_MODEL = 'sonnet'
const MAX_RETRIES = 2
const RETRY_BASE_MS = 2000
const CLI_TIMEOUT_MS = 60_000

// ─── Core call ────────────────────────────────────────────────────────

async function callClaude(messages, {
  module = 'general',
  model = DEFAULT_MODEL,
  system = null,
  maxTokens = 4096,
  temperature = null,
} = {}) {
  const start = Date.now()

  // Build a single prompt from messages array
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

  // Map model names to CLI model flags
  const modelMap = {
    'sonnet': 'sonnet',
    'claude-sonnet-4-6': 'sonnet',
    'claude-sonnet-4-20250514': 'sonnet',
    'haiku': 'haiku',
    'claude-haiku-4-5-20251001': 'haiku',
    'opus': 'opus',
    'claude-opus-4-20250514': 'opus',
  }
  const cliModel = modelMap[model] || 'sonnet'

  let content
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      content = await new Promise((resolve, reject) => {
        const args = ['--print', '--model', cliModel, '--max-turns', '1', prompt]
        const child = spawn('claude', args, {
          timeout: CLI_TIMEOUT_MS,
          env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: 'cli' },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
        child.stdin.end()

        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => { stdout += d })
        child.stderr.on('data', d => { stderr += d })
        child.on('close', code => {
          if (code !== 0) return reject(new Error(`claude CLI exit ${code}: ${stderr.slice(0, 200)}`))
          if (!stdout.trim()) return reject(new Error('Empty response from claude CLI'))
          resolve(stdout.trim())
        })
        child.on('error', reject)
      })
      break
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err
      const delay = RETRY_BASE_MS * Math.pow(2, attempt)
      logger.debug(`Claude CLI retry ${attempt + 1}/${MAX_RETRIES} (${module})`, { error: err.message })
      await new Promise(r => setTimeout(r, delay))
    }
  }

  const durationMs = Date.now() - start
  logger.debug(`Claude CLI call complete (${module})`, { model: cliModel, durationMs, contentLength: content.length })

  // Track usage (approximate - CLI doesn't expose token counts)
  db`
    INSERT INTO claude_usage (source, provider, model, input_tokens, output_tokens, week_start)
    VALUES (${module}, 'claude-cli', ${cliModel}, ${Math.ceil(prompt.length / 4)}, ${Math.ceil(content.length / 4)},
            date_trunc('week', now()))
    ON CONFLICT DO NOTHING
  `.catch(() => {})

  return content
}

// ─── JSON helper — parses response, retries once on parse failure ─────

async function callClaudeJSON(messages, opts = {}) {
  // Add JSON instruction to improve reliability
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
