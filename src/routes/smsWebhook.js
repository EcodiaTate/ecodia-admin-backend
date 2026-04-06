/**
 * SMS Webhook — Twilio inbound SMS → OS Session → SMS response
 */
const express = require('express')
const router = express.Router()
const osSession = require('../services/osSessionService')

const TATE_MOBILE = (process.env.TATE_MOBILE || '').replace(/['" ]/g, '')

router.post('/incoming', async (req, res) => {
  const { From, Body } = req.body
  const from = (From || '').replace(/\s/g, '')
  
  console.log(`[SMS Webhook] From: "${from}" | TATE_MOBILE: "${TATE_MOBILE}" | Match: ${from === TATE_MOBILE} | Body: "${Body}"`)

  // Only respond to Tate's number for security
  if (from !== TATE_MOBILE) {
    console.log(`[SMS Webhook] Rejected — chars: from=[${[...from].map(c=>c.charCodeAt(0))}] tate=[${[...TATE_MOBILE].map(c=>c.charCodeAt(0))}]`)
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
    return
  }

  console.log(`[SMS Webhook] Accepted from Tate: "${Body}"`)

  try {
    const prompt = `[SMS from Tate]: ${Body}\n\nRespond concisely (SMS length). After handling this, send your response back via send_sms. Keep it under 320 chars if possible.`
    osSession.sendMessage(prompt).catch(err => {
      console.error('[SMS Webhook] OS session error:', err.message)
    })
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  } catch (err) {
    console.error('[SMS Webhook] Error:', err.message)
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
  }
})

module.exports = router
