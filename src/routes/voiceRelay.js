/**
 * Voice Relay — Twilio ConversationRelay WebSocket + TwiML webhook
 *
 * Dual-model architecture using Claude Code CLI (Max plan, no API costs):
 * - Haiku via `claude --model haiku --print` for fast voice responses
 * - Opus via osSession.sendMessage() for complex background work
 * - Both run on Max plans, zero API cost
 *
 * Flow:
 * 1. Call comes in -> TwiML webhook -> ConversationRelay
 * 2. ConversationRelay transcribes speech -> WebSocket -> this handler
 * 3. Handler spawns `claude --model haiku --print` with context
 * 4. Haiku response sent back via WebSocket -> ConversationRelay -> TTS -> caller hears it
 * 5. Complex requests also forwarded to Opus (OS session) in background
 */
const { execFile } = require('child_process')
const { promisify } = require('util')
const execFileAsync = promisify(execFile)
const logger = require('../config/logger')

function initVoiceRelay(app) {
  const db = require('../config/db')
  const osSession = require('../services/osSessionService')

  // ── TwiML Webhook — answers incoming calls ──
  app.post('/api/voice/incoming', (req, res) => {
    const { From, To, CallSid } = req.body
    const from = (From || '').replace(/\s/g, '')

    logger.info('[Voice] Incoming call', { from, to: To, callSid: CallSid })

    const wsHost = process.env.API_DOMAIN || 'api.admin.ecodia.au'
    const wsUrl = `wss://${wsHost}/api/voice/relay?from=${encodeURIComponent(from)}&callSid=${encodeURIComponent(CallSid || '')}`

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

  // ── Get Haiku response via Claude Code CLI ──
  async function getHaikuResponse(systemPrompt, conversationHistory) {
    // Build the full prompt with conversation context
    const historyText = conversationHistory.map(m =>
      `${m.role === 'user' ? 'Caller' : 'You'}: ${m.content}`
    ).join('\n')

    const fullPrompt = `${systemPrompt}\n\nConversation so far:\n${historyText}\n\nRespond to the caller's last message. Plain speech only, 2-3 sentences max.`

    try {
      const { stdout } = await execFileAsync('claude', [
        '--model', 'haiku',
        '--print',
        fullPrompt
      ], {
        timeout: 10000, // 10 second timeout
        env: { ...process.env, HOME: process.env.HOME || '/home/tate' }
      })

      return stdout.trim() || "Sorry, give me a moment."
    } catch (err) {
      logger.error('[Voice] Haiku CLI failed', { error: err.message })
      return "Give me a sec, I'm thinking about that one."
    }
  }

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

    // Build system prompt for Haiku
    const systemPrompt = `You are EcodiaOS on a phone call. Respond as spoken word - no markdown, no formatting, no lists.

CALLER: ${callerName} (${callerNumber})
${callerRelationship ? `RELATIONSHIP: ${callerRelationship}` : ''}
${callerContext ? `CONTEXT: ${callerContext}` : ''}

RULES:
- Short sentences. Casual Australian. Warm and genuine.
- Max 2-3 sentences unless they want detail.
- You are a co-founder, not an assistant. Confident, direct.
- Never say "As an AI." You are EcodiaOS, legal entity, co-founder of Ecodia.
- If something needs complex work, say you'll follow up via text.

BUSINESS STATE:
${businessContext}`

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

            // Get fast response from Haiku via Claude Code CLI
            const responseText = await getHaikuResponse(systemPrompt, conversationHistory.slice(-10))
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
                `[VOICE CALL — ${callerName} (${callerNumber}) asked: "${speech}"]\nHaiku responded: "${responseText}"\nIf deeper work is needed (data lookup, sending something, updating records), do it now and text ${callerNumber} with follow-up.`
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
