const logger = require('../config/logger')
const db = require('../config/db')
const { broadcastToSession } = require('../websocket/wsManager')
const { appendLog, updateSessionStatus } = require('../db/queries/ccSessions')

// Claude Code session management via Anthropic Agent SDK
// TODO: Implement with @anthropic-ai/claude-agent-sdk once available on VPS

const activeSessions = new Map()

async function startSession(session) {
  logger.info(`Starting CC session ${session.id}`, {
    projectId: session.project_id,
    workingDir: session.working_dir,
  })

  await updateSessionStatus(session.id, 'running')

  // TODO: Spawn CC process via child_process or Agent SDK
  // Stream stdout to WS via broadcastToSession
  // Store chunks via appendLog

  logger.warn('CC session start not yet implemented — needs Agent SDK setup on VPS')
}

async function sendMessage(sessionId, content) {
  const session = activeSessions.get(sessionId)
  if (!session) throw new Error('Session not found or not running')
  // TODO: Write to CC process stdin
  logger.warn('CC sendMessage not yet implemented')
}

async function stopSession(sessionId) {
  const session = activeSessions.get(sessionId)
  if (session) {
    // TODO: Kill CC process gracefully
    activeSessions.delete(sessionId)
  }
  await updateSessionStatus(sessionId, 'complete')
  logger.info(`CC session ${sessionId} stopped`)
}

module.exports = { startSession, sendMessage, stopSession }
