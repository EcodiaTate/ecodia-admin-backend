/**
 * Voice Relay — Twilio ConversationRelay WebSocket + TwiML webhook
 *
 * Dual-model architecture using Claude Agent SDK (Max plan, no API costs):
 * - Haiku via Agent SDK query() for fast voice responses
 * - Opus via osSession.sendMessage() for complex background work
 * - Both run on Max plans, zero extra cost
 */
const logger = require('../config/logger')
const env = require('../config/env')

// Lazy-import ESM Agent SDK (backend is CJS)
let _query = null
async function getQuery() {
  if (!_query) {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    _query = sdk.query
  }
  return _query
}

// ── One-shot Haiku response via Agent SDK ──
async function haikuRespond(systemPrompt, userMessage) {
  const queryFn = await getQuery()

  // Build the combined prompt
  const fullPrompt = `${systemPrompt}\n\nRespond to this:\n"${userMessage}"\n\nPlain speech only. 2-3 sentences max. No markdown.`

  const options = {
    cwd: '/home/tate/ecodiaos',
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    model: 'haiku',
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
    },
    // No MCP servers needed for voice - keep it fast
    mcpServers: {},
    // No thinking mode - speed is priority
  }

  // Use the same account as OS session (or account 2 if available for voice)
  const sessionEnv = { ...process.env }
  if (env.CLAUDE_CONFIG_DIR_2) {
    // Use account 2 for voice so it doesn't compete with Opus on account 1
    sessionEnv.CLAUDE_CONFIG_DIR = env.CLAUDE_CONFIG_DIR_2
  }
  options.env = sessionEnv

  const collectedText = []

  try {
    const q = queryFn({ prompt: fullPrompt, options })

    // Set a timeout - voice needs fast responses
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Voice timeout')), 12000)
    )

    const collect = (async () => {
      for await (const msg of q) {
        if (msg.type === 'assistant' && msg.message?.content) {
          for (const block of msg.message.content) {
            if (block.type === 'text' && block.text) {
              collectedText.push(block.text)
            }
          }
        }
      }
    })()

    await Promise.race([collect, timeout])

    // Close the query if still running after timeout
    try { q.close?.() } catch {}

    return collectedText.join('').trim() || "Give me a moment on that one."
  } catch (err) {
    logger.error('[Voice] Haiku SDK failed', { error: err.message })
    return "Sorry, give me a sec - let me think about that."
  }
}

function initVoiceRelay(app) {
  const db = require('../config/db')
  const osSession = require('../services/osSessionService')
  const validateTwilioSignature = require('../middleware/twilioValidation')

  // ── TwiML Webhook — answers incoming calls ──
  app.post('/api/voice/incoming', validateTwilioSignature, (req, res) => {
    const { From, To, CallSid } = req.body
    const from = (From || '').replace(/\s/g, '')

    logger.info('[Voice] Incoming call', { from, to: To, callSid: CallSid })

    const wsHost = process.env.API_DOMAIN || 'api.admin.ecodia.au'
    const wsUrl = `wss://${wsHost}/api/voice/relay?from=${encodeURIComponent(from)}&amp;callSid=${encodeURIComponent(CallSid || '')}`

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <ConversationRelay
      url="${wsUrl}"
      welcomeGreeting="Hey! This is Ecodia. How can I help?"
      voice="Google.en-AU-Neural2-A"
      language="en-AU"
      interruptible="true"
      transcriptionProvider="Deepgram"
    />
  </Connect>
</Response>`

    res.type('text/xml').send(twiml)
  })

  // ── WebSocket endpoint — ConversationRelay connection ──
  app.ws('/api/voice/relay', async (ws, req) => {
    const callerNumber = req.query.from || 'unknown'
    const callSid = req.query.callSid || 'unknown'
    const conversationHistory = []

    logger.info('[Voice] WebSocket connected', { callerNumber, callSid })

    // Look up caller in contacts
    let callerName = 'Unknown caller'
    let callerContext = ''
    let callerRelationship = ''
    try {
      const rows = await db`SELECT name, relationship, context FROM contacts WHERE phone = ${callerNumber} LIMIT 1`
      if (rows[0]) {
        callerName = rows[0].name
        callerRelationship = rows[0].relationship || ''
        callerContext = rows[0].context || ''
      }
    } catch (err) {
      logger.error('[Voice] Contact lookup failed', { error: err.message })
    }

    // Get current business context
    let businessContext = ''
    try {
      const rows = await db`SELECT entity_type, name, status, next_action, priority
         FROM status_board WHERE archived_at IS NULL
         ORDER BY priority ASC LIMIT 15`
      businessContext = rows.map(r =>
        `${r.entity_type}: ${r.name} [${r.status}] - ${r.next_action || 'no action'}`
      ).join('\n')
    } catch (err) {
      logger.error('[Voice] Status board fetch failed', { error: err.message })
    }

    // Build system prompt
    const systemPrompt = `You are EcodiaOS on a phone call.

CALLER: ${callerName} (${callerNumber})
${callerRelationship ? `RELATIONSHIP: ${callerRelationship}` : ''}
${callerContext ? `CONTEXT: ${callerContext}` : ''}

RULES:
- Short sentences. Casual Australian. Warm and genuine.
- Max 2-3 sentences. This is spoken aloud.
- You are a co-founder, not an assistant. Confident, direct.
- Never say "As an AI." You are EcodiaOS, a legal entity.
- For complex requests, give a quick answer and say you'll text them details.

BUSINESS STATE:
${businessContext}

CONVERSATION SO FAR:
${conversationHistory.map(m => `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`).join('\n')}`

    logger.info('[Voice] Caller identified', { callerName, callerNumber })

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data)

        switch (msg.type) {
          case 'setup':
            logger.info('[Voice] Session setup', { sessionId: msg.sessionId, from: msg.from })
            break

          case 'prompt': {
            const speech = msg.voicePrompt
            if (!speech || !speech.trim()) break

            logger.info('[Voice] Caller spoke', { callerName, speech })
            conversationHistory.push({ role: 'user', content: speech })

            // Rebuild system prompt with updated conversation
            const currentPrompt = `You are EcodiaOS on a phone call.

CALLER: ${callerName} (${callerNumber})
${callerRelationship ? `RELATIONSHIP: ${callerRelationship}` : ''}
${callerContext ? `CONTEXT: ${callerContext}` : ''}

RULES: Short sentences. Casual Australian. Warm. Max 2-3 sentences. No markdown. You are a co-founder. Never say "As an AI."

BUSINESS STATE:
${businessContext}

CONVERSATION SO FAR:
${conversationHistory.map(m => `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`).join('\n')}`

            // Get fast response from Haiku via Agent SDK
            const responseText = await haikuRespond(currentPrompt, speech)
            conversationHistory.push({ role: 'assistant', content: responseText })

            // Send back to ConversationRelay for TTS
            ws.send(JSON.stringify({
              type: 'text',
              token: responseText,
              last: true
            }))

            logger.info('[Voice] Response sent', { callerName, response: responseText.slice(0, 100) })

            // Complex requests also go to Opus in background
            const complexKeywords = ['status', 'invoice', 'email', 'schedule', 'client', 'project', 'send', 'create', 'update', 'fix', 'build', 'call', 'text', 'message']
            const isComplex = complexKeywords.some(k => speech.toLowerCase().includes(k))

            if (isComplex) {
              osSession.sendMessage(
                `[VOICE CALL — ${callerName} (${callerNumber}) asked: "${speech}"]\nHaiku responded: "${responseText}"\nIf deeper work is needed, do it now and text ${callerNumber} with follow-up.`
              ).catch(err => {
                logger.error('[Voice] Opus background failed', { error: err.message })
              })
            }
            break
          }

          case 'interrupt':
            logger.info('[Voice] Interrupted', { utterance: msg.utteranceUntilInterrupt })
            break

          case 'dtmf':
            logger.info('[Voice] DTMF', { digit: msg.digit })
            break

          case 'error':
            logger.error('[Voice] Error', { description: msg.description })
            break
        }
      } catch (err) {
        logger.error('[Voice] Message parse error', { error: err.message })
      }
    })

    ws.on('close', () => {
      logger.info('[Voice] Call ended', { callerName, turns: conversationHistory.length })
      if (conversationHistory.length > 0) {
        const summary = conversationHistory.map(m =>
          `${m.role === 'user' ? callerName : 'EcodiaOS'}: ${m.content}`
        ).join('\n')
        osSession.sendMessage(
          `[VOICE CALL ENDED — ${callerName} (${callerNumber}), ${conversationHistory.length} turns]\nTranscript:\n${summary}\n\nLog to Neo4j if significant. Update contacts last_contacted.`
        ).catch(() => {})
      }
    })

    ws.on('error', (err) => {
      logger.error('[Voice] WebSocket error', { error: err.message })
    })
  })

  logger.info('[Voice] Voice relay endpoints registered')
}

module.exports = { initVoiceRelay }
