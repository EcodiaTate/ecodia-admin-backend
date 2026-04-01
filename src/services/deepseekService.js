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

  await db`
    INSERT INTO deepseek_usage (model, prompt_tokens, completion_tokens, cost_usd, module, duration_ms)
    VALUES (${model}, ${usage.prompt_tokens}, ${usage.completion_tokens},
            ${(usage.prompt_tokens * 0.14 + usage.completion_tokens * 0.28) / 1_000_000},
            ${module}, ${durationMs})
  `.catch(err => logger.warn('Failed to track DeepSeek usage', { error: err.message }))

  return response.data.choices[0].message.content
}

function parseJSON(content) {
  try {
    return JSON.parse(content)
  } catch {
    const match = content.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (match) return JSON.parse(match[1].trim())
    throw new Error(`Failed to parse DeepSeek response as JSON: ${content.slice(0, 200)}`)
  }
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

  return parseJSON(await callDeepSeek([{ role: 'user', content: prompt }], { module: 'finance' }))
}

async function triageEmail({ subject, from, body, snippet, inbox, clientContext }) {
  const prompt = `You are Tate Donohoe's email assistant. Tate is a 21-year-old software developer running Ecodia Pty Ltd in Australia. He builds custom software for impact-focused organisations.

This email arrived in the ${inbox || 'code@ecodia.au'} inbox.

From: ${from}
Subject: ${subject}
${clientContext ? `Known client: ${clientContext.name} (Stage: ${clientContext.stage})` : 'Unknown sender'}

Body:
${(body || snippet || '').slice(0, 3000)}

Classify this email and decide what action to take. Be aggressive about filtering noise — Tate only wants to see emails that genuinely need his attention.

Respond with JSON only:
{
  "priority": "urgent|high|normal|low|spam",
  "summary": "one concise sentence summarizing what this email is about and what it wants",
  "suggestedAction": "reply|archive|forward|create_task|ignore",
  "reasoning": "why this priority and action",
  "draftReply": "if suggestedAction is reply, write a natural reply in Tate's voice (direct, friendly, no corporate fluff, signs off as just 'Tate'). null if no reply needed",
  "shouldCreateTask": true or false,
  "taskTitle": "task title if shouldCreateTask is true, null otherwise",
  "taskDescription": "task detail if applicable, null otherwise",
  "taskPriority": "low|medium|high|urgent (only if shouldCreateTask is true)"
}

Priority guide:
- urgent: needs response within hours, money/deadline/legal on the line
- high: needs response today, from a client or important contact
- normal: should respond eventually, informational
- low: newsletters, receipts, automated notifications — no action needed
- spam: marketing, unsolicited outreach, junk`

  return parseJSON(await callDeepSeek([{ role: 'user', content: prompt }], { module: 'gmail' }))
}

async function draftEmailReply(thread) {
  const prompt = `Draft a reply to this email for Tate Donohoe, founder of Ecodia Pty Ltd (software development company based in Australia).

From: ${thread.from_name || thread.from_email}
Subject: ${thread.subject}
Body: ${(thread.full_body || thread.snippet || '').slice(0, 3000)}

Write a clear, natural reply. Tate's style: direct, friendly, no corporate fluff. Keep it concise. Sign off as just "Tate".`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: 'gmail' })
}

async function draftLinkedInReply(dm) {
  const messages = dm.messages || []
  const lastMessages = messages.slice(-5)

  const prompt = `Draft a LinkedIn DM reply for Tate Donohoe, founder of Ecodia (software development).

Conversation with ${dm.participant_name}:
${lastMessages.map(m => `${m.sender}: ${m.text}`).join('\n')}

Write a brief, friendly, professional reply. Keep it conversational for LinkedIn.`

  return callDeepSeek([{ role: 'user', content: prompt }], { module: 'linkedin' })
}

module.exports = { callDeepSeek, categorize, triageEmail, draftEmailReply, draftLinkedInReply }
