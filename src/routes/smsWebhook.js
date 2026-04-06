/**
 * SMS Webhook — Twilio inbound SMS → OS Session → SMS response
 * Lets Tate text the business number and get an AI response.
 */
const express = require('express')
const router = express.Router()
const osSession = require('../services/osSessionService')
const twilio = require('twilio')

const TATE_MOBILE = (process.env.TATE_MOBILE || '').replace(/['" ]/g, '')

// Twilio sends POST to this endpoint when an SMS arrives
router.post('/incoming', async (req, res) => {
  const { From, Body } = req.body
  const twiml = new twilio.twiml.MessagingResponse()

  // Only respond to Tate's number for security
  const from = (From || '').replace(/\s/g, '')
  if (from !== TATE_MOBILE) {
    console.log(`[SMS Webhook] Rejected SMS from unknown number: ${from}`)
    twiml.message('Unauthorized.')
    res.type('text/xml').send(twiml.toString())
    return
  }

  console.log(`[SMS Webhook] Received from Tate: "${Body}"`)

  try {
    // Prefix the message so the OS session knows it came via SMS
    const prompt = `[SMS from Tate]: ${Body}\n\nRespond concisely (SMS length). After handling this, send your response back via send_sms. Keep it under 320 chars if possible.`
    
    // Fire to OS session — don't await the full response (it may take minutes)
    // Instead, let the OS session handle sending the SMS reply itself
    osSession.sendMessage(prompt).catch(err => {
      console.error('[SMS Webhook] OS session error:', err.message)
    })

    // Acknowledge to Twilio immediately (empty response — we'll reply via API)
    res.type('text/xml').send(twiml.toString())
  } catch (err) {
    console.error('[SMS Webhook] Error:', err.message)
    twiml.message('Error processing your message. Try again.')
    res.type('text/xml').send(twiml.toString())
  }
})

module.exports = router
