#!/usr/bin/env node
/**
 * Twilio SMS & Voice MCP Server
 *
 * Tools: send_sms, make_call, list_messages, list_calls
 * Uses Twilio REST API for outbound comms to anyone.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import twilio from 'twilio'

const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN
const FROM_NUMBER = (process.env.TWILIO_FROM_NUMBER || '').trim()

if (!ACCOUNT_SID || !AUTH_TOKEN || !FROM_NUMBER) {
  console.error('Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_FROM_NUMBER')
  process.exit(1)
}

const client = twilio(ACCOUNT_SID, AUTH_TOKEN)
const server = new McpServer({ name: 'sms', version: '1.0.0' })

// ── Send SMS ──

server.tool(
  'send_sms',
  'Send an SMS message to any phone number. Use E.164 format (+61404247153).',
  { to: z.string().describe('Recipient phone number in E.164 format'), body: z.string().describe('Message text (max 1600 chars)') },
  async ({ to, body }) => {
    try {
      const msg = await client.messages.create({
        to,
        from: FROM_NUMBER,
        body: body.slice(0, 1600),
      })
      return { content: [{ type: 'text', text: `SMS sent to ${to}. SID: ${msg.sid}, Status: ${msg.status}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `SMS failed: ${err.message}` }], isError: true }
    }
  }
)

// ── Make Voice Call ──

server.tool(
  'make_call',
  'Make a voice call with text-to-speech message. Recipient hears the message read aloud.',
  {
    to: z.string().describe('Recipient phone number in E.164 format'),
    message: z.string().describe('Message to speak (text-to-speech)'),
    voice: z.string().optional().describe('Voice: man, woman, alice, Polly.Amy, etc. Default: Polly.Amy'),
  },
  async ({ to, message, voice }) => {
    try {
      const twiml = `<Response><Say voice="${voice || 'Polly.Amy'}">${message.replace(/[<>&"']/g, '')}</Say></Response>`
      const call = await client.calls.create({
        to,
        from: FROM_NUMBER,
        twiml,
      })
      return { content: [{ type: 'text', text: `Call initiated to ${to}. SID: ${call.sid}, Status: ${call.status}` }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `Call failed: ${err.message}` }], isError: true }
    }
  }
)

// ── List Recent Messages ──

server.tool(
  'list_messages',
  'List recent SMS messages sent or received.',
  {
    limit: z.number().optional().describe('Number of messages to return (default 10, max 50)'),
    to: z.string().optional().describe('Filter by recipient number'),
    from: z.string().optional().describe('Filter by sender number'),
  },
  async ({ limit, to, from }) => {
    try {
      const opts = { limit: Math.min(limit || 10, 50) }
      if (to) opts.to = to
      if (from) opts.from = from
      const messages = await client.messages.list(opts)
      const summary = messages.map(m => ({
        sid: m.sid,
        from: m.from,
        to: m.to,
        body: m.body,
        status: m.status,
        date: m.dateCreated?.toISOString(),
        direction: m.direction,
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `List failed: ${err.message}` }], isError: true }
    }
  }
)

// ── List Recent Calls ──

server.tool(
  'list_calls',
  'List recent voice calls made or received.',
  {
    limit: z.number().optional().describe('Number of calls to return (default 10, max 50)'),
    to: z.string().optional().describe('Filter by recipient number'),
  },
  async ({ limit, to }) => {
    try {
      const opts = { limit: Math.min(limit || 10, 50) }
      if (to) opts.to = to
      const calls = await client.calls.list(opts)
      const summary = calls.map(c => ({
        sid: c.sid,
        from: c.from,
        to: c.to,
        status: c.status,
        duration: c.duration,
        direction: c.direction,
        date: c.startTime?.toISOString(),
      }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `List failed: ${err.message}` }], isError: true }
    }
  }
)

// ── Start ──

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('SMS MCP server running')
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
