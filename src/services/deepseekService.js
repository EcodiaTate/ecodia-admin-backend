const axios = require('axios')
const env = require('../config/env')
const logger = require('../config/logger')
const db = require('../config/db')

const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1/chat/completions'

async function callDeepSeek(messages, { module = 'general', model = 'deepseek-chat' } = {}) {
  const start = Date.now()

  const response = await axios.post(
    DEEPSEEK_API_URL,
    { model, messages, temperature: 0.3 },
    { headers: { Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' } }
  )

  const usage = response.data.usage
  const durationMs = Date.now() - start

  // Track usage
  await db`
    INSERT INTO deepseek_usage (model, prompt_tokens, completion_tokens, cost_usd, module, duration_ms)
    VALUES (${model}, ${usage.prompt_tokens}, ${usage.completion_tokens},
            ${(usage.prompt_tokens * 0.14 + usage.completion_tokens * 0.28) / 1_000_000},
            ${module}, ${durationMs})
  `.catch(err => logger.warn('Failed to track DeepSeek usage', { error: err.message }))

  return response.data.choices[0].message.content
}

async function categorize({ description, amount, type, date }) {
  const prompt = `You are an Australian business bookkeeper. Categorize this transaction for Ecodia Pty Ltd, a software development company.

Transaction:
- Description: ${description}
- Amount: AUD ${Math.abs(amount)} (${type})
- Date: ${date}

Respond with JSON only:
{
  "category": "one of: Software Subscriptions, Cloud Infrastructure, Contractor Payments, Office/Admin, Marketing, Travel, Meals/Entertainment, Legal/Accounting, Income - Software Dev, Income - Consulting, Tax, Superannuation, Bank Fees, Other",
  "confidence": 0.0-1.0,
  "xeroAccountCode": "relevant Xero account code if known",
  "notes": "brief rationale"
}`

  const content = await callDeepSeek([{ role: 'user', content: prompt }], { module: 'finance' })

  try {
    return JSON.parse(content)
  } catch {
    // Try extracting JSON from markdown code block
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse DeepSeek response as JSON: ${content.slice(0, 200)}`)
  }
}

async function triageEmail({ subject, from, body, snippet }) {
  const prompt = `You are triaging an email for a software development business (Ecodia Pty Ltd).

From: ${from}
Subject: ${subject}
Body: ${body || snippet}

Respond with JSON only:
{
  "priority": "one of: urgent, high, normal, low, spam",
  "summary": "one-line summary",
  "suggestedAction": "brief action recommendation"
}`

  const content = await callDeepSeek([{ role: 'user', content: prompt }], { module: 'gmail' })

  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse triage response: ${content.slice(0, 200)}`)
  }
}

async function draftEmailReply(thread) {
  const prompt = `Draft a professional reply to this email for Kurt Jones, founder of Ecodia Pty Ltd (software development company).

From: ${thread.from_name || thread.from_email}
Subject: ${thread.subject}
Body: ${thread.full_body || thread.snippet}

Write a clear, professional reply. Be concise. Sign off as Kurt.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: 'gmail' })
}

async function draftLinkedInReply(dm) {
  const messages = dm.messages || []
  const lastMessages = messages.slice(-5)

  const prompt = `Draft a LinkedIn DM reply for Kurt Jones, founder of Ecodia (software development).

Conversation with ${dm.participant_name}:
${lastMessages.map(m => `${m.sender}: ${m.text}`).join('\n')}

Write a brief, friendly, professional reply. Keep it conversational for LinkedIn.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: 'linkedin' })
}

module.exports = { callDeepSeek, categorize, triageEmail, draftEmailReply, draftLinkedInReply }
