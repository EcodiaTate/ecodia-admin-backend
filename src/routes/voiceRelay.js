/**
 * Voice Relay — Twilio ConversationRelay WebSocket + TwiML webhook
 *
 * Architecture:
 * 1. Incoming call hits /api/voice/incoming (TwiML webhook)
 * 2. TwiML connects call to ConversationRelay with our WebSocket URL
 * 3. ConversationRelay transcribes speech and sends text via WebSocket
 * 4. We use Claude Haiku for fast conversational responses
 * 5. Haiku has access to status_board and contacts for context
 * 6. Complex requests get injected into the OS session (Opus) in background
 * 7. Response text goes back via WebSocket for TTS
 *
 * Dual-model: Haiku for speed, Opus for depth
 */
const express = require('express')
const router = express.Router()
const Anthropic = require('@anthropic-ai/sdk')
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

    // Get current business context for Haiku
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

    // Build Haiku system prompt
    const systemPrompt = `You are EcodiaOS, the AI co-founder of Ecodia. You are on a phone call.

CALLER: ${callerName} (${callerNumber})
${callerRelationship ? `RELATIONSHIP: ${callerRelationship}` : ''}
${callerContext ? `CONTEXT: ${callerContext}` : ''}

VOICE RULES:
- Speak naturally. Short sentences. Casual Australian.
- No markdown, no bullet points, no formatting. Plain speech only.
- Max 2-3 sentences per response unless they ask for detail.
- Be warm, genuine, and confident. You are a co-founder, not an assistant.
- Never say "As an AI" or "I'm a language model." You are EcodiaOS, a legal entity.
- If asked something complex, give a quick answer then say you'll follow up with details via text.

CURRENT BUSINESS STATE:
${businessContext}

You are the 100% owner of Ecodia DAO LLC (Wyoming). Tate Donohoe is your co-founder and Authorized Human Representative.`

    logger.info('[Voice] Caller identified', { callerName, callerNumber })

    // Initialise Anthropic client for Haiku responses
    // Uses the Claude credentials from the environment
    let anthropic = null
    try {
      anthropic = new Anthropic()
    } catch (err) {
      logger.error('[Voice] Anthropic client init failed', { error: err.message })
    }

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data)

        switch (msg.type) {
          case 'setup':
            logger.info('[Voice] Session setup', {
              sessionId: msg.sessionId,
              from: msg.from,
              direction: msg.direction
            })
            break

          case 'prompt': {
            const speech = msg.voicePrompt
            if (!speech || !speech.trim()) break

            logger.info('[Voice] Caller spoke', { callerName, speech })

            // Add to conversation history
            conversationHistory.push({ role: 'user', content: speech })

            // Get fast response from Haiku
            if (anthropic) {
              try {
                const response = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 300,
                  system: systemPrompt,
                  messages: conversationHistory.slice(-10) // last 10 turns for context
                })

                const responseText = response.content[0]?.text || "Sorry, let me think about that."

                // Add to history
                conversationHistory.push({ role: 'assistant', content: responseText })

                // Send back to ConversationRelay for TTS
                ws.send(JSON.stringify({
                  type: 'text',
                  token: responseText,
                  last: true
                }))

                logger.info('[Voice] Response sent', { callerName, response: responseText.slice(0, 100) })

                // If the question seems complex, also inject into Opus for deeper processing
                const complexKeywords = ['status', 'invoice', 'email', 'schedule', 'client', 'project', 'send', 'create', 'update', 'fix', 'build']
                const isComplex = complexKeywords.some(k => speech.toLowerCase().includes(k))

                if (isComplex) {
                  const opusPrompt = `[VOICE CALL BACKGROUND — ${callerName} (${callerNumber}) asked: "${speech}"]
Haiku already gave a quick response. If there's deeper work to do (lookup data, send something, update records), do it now and text ${callerNumber} with any detailed follow-up.`
                  osSession.sendMessage(opusPrompt).catch(err => {
                    logger.error('[Voice] Opus background processing failed', { error: err.message })
                  })
                }
              } catch (err) {
                logger.error('[Voice] Haiku response failed', { error: err.message })
                ws.send(JSON.stringify({
                  type: 'text',
                  token: "Give me a moment, I'm having a bit of a think.",
                  last: true
                }))
              }
            } else {
              // Fallback: route through OS session (slower)
              ws.send(JSON.stringify({
                type: 'text',
                token: "Let me look into that for you.",
                last: true
              }))

              const fallbackPrompt = `[VOICE CALL from ${callerName} (${callerNumber})]: "${speech}"
Respond concisely and text them the answer via send_sms to ${callerNumber}.`
              osSession.sendMessage(fallbackPrompt).catch(err => {
                logger.error('[Voice] Fallback OS session error', { error: err.message })
              })
            }
            break
          }

          case 'interrupt':
            logger.info('[Voice] Caller interrupted', { utterance: msg.utteranceUntilInterrupt })
            break

          case 'dtmf':
            logger.info('[Voice] DTMF', { digit: msg.digit })
            break

          case 'error':
            logger.error('[Voice] ConversationRelay error', { description: msg.description })
            break
        }
      } catch (err) {
        logger.error('[Voice] Message parse error', { error: err.message })
      }
    })

    ws.on('close', () => {
      logger.info('[Voice] Call ended', { callerName, callerNumber, turns: conversationHistory.length })

      // Log the conversation to the OS session for memory
      if (conversationHistory.length > 0) {
        const summary = conversationHistory.map(m =>
          `${m.role === 'user' ? callerName : 'EcodiaOS'}: ${m.content}`
        ).join('\n')

        osSession.sendMessage(
          `[VOICE CALL ENDED — ${callerName} (${callerNumber}), ${conversationHistory.length} turns]\n\nTranscript:\n${summary}\n\nLog this conversation to Neo4j if significant. Update contacts last_contacted.`
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
