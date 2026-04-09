/**
 * SMS Webhook - Twilio inbound SMS → OS Session → SMS response
 * Accepts messages from anyone in the contacts table (can_sms = true)
 * and from Tate's mobile number.
 */
const express = require('express')
const router = express.Router()
const osSession = require('../services/osSessionService')
const postgres = require('postgres')

const TATE_MOBILE = (process.env.TATE_MOBILE || '').replace(/['" ]/g, '')
const db = postgres(process.env.DATABASE_URL, { max: 2, idle_timeout: 30 })

async function lookupContact(phone) {
  try {
    const rows = await db`SELECT name, relationship, context FROM contacts WHERE phone = ${phone} AND can_sms = true LIMIT 1`
    return rows[0] || null
  } catch { return null }
}

router.post('/incoming', async (req, res) => {
  const { From, Body } = req.body
  const from = (From || '').replace(/\s/g, '')

  // Look up contact in database
  const contact = await lookupContact(from)
  const isTate = from === TATE_MOBILE
  const isKnown = isTate || !!contact
  const senderName = isTate ? 'Tate' : contact?.name || 'Unknown'

  console.log(`[SMS Webhook] From: "${from}" | Known: ${isKnown} | Sender: ${senderName} | Body: "${Body}"`)

  if (!isKnown) {
    console.log(`[SMS Webhook] Rejected unknown number: ${from}`)
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>')
    return
  }

  console.log(`[SMS Webhook] Accepted from ${senderName}: "${Body}"`)

  try {
    const context = contact ? `Relationship: ${contact.relationship || 'unknown'}. Context: ${contact.context || 'none'}.` : ''
    const prompt = `[SMS from ${senderName} (${from})]: ${Body}\n\n${context}\n\nRespond concisely (SMS length). Send your response back via send_sms to ${from}. Keep it under 320 chars if possible. Be warm and genuine. If this is not Tate, remember your tone should match the relationship.`
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
