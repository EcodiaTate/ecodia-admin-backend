const db = require('../config/db')
const logger = require('../config/logger')

const ENABLED = process.env.OS_CONV_LOG_ENABLED === 'true'

function _disabled(fn) {
  logger.debug(`os_conversation_log disabled, skipping (${fn})`)
  return null
}

async function logTurn({ ccSessionId, turnNumber, role, content, contentJson, tokenCount }) {
  if (!ENABLED) return _disabled('logTurn')
  await db`
    INSERT INTO os_conversation (cc_session_id, turn_number, role, content, content_json, token_count)
    VALUES (${ccSessionId}, ${turnNumber}, ${role}, ${content ?? null}, ${contentJson ?? null}, ${tokenCount ?? null})
  `
  return null
}

async function getRecentTurns(ccSessionId, limit = 50) {
  if (!ENABLED) return _disabled('getRecentTurns')
  const rows = await db`
    SELECT * FROM os_conversation
    WHERE cc_session_id = ${ccSessionId}
      AND superseded_by_compact_id IS NULL
    ORDER BY turn_number DESC
    LIMIT ${limit}
  `
  return rows.reverse()
}

async function getNextTurnNumber(ccSessionId) {
  if (!ENABLED) return _disabled('getNextTurnNumber')
  const [row] = await db`
    SELECT COALESCE(MAX(turn_number), -1) + 1 AS next_turn
    FROM os_conversation
    WHERE cc_session_id = ${ccSessionId}
  `
  return row.next_turn
}

async function logCompact({ ccSessionId, summary, turnRangeStart, turnRangeEnd, tokensBefore, tokensAfter }) {
  if (!ENABLED) return _disabled('logCompact')
  const [row] = await db`
    INSERT INTO os_compacts (cc_session_id, summary, turn_range_start, turn_range_end, tokens_before, tokens_after)
    VALUES (${ccSessionId}, ${summary}, ${turnRangeStart}, ${turnRangeEnd}, ${tokensBefore ?? null}, ${tokensAfter ?? null})
    RETURNING id
  `
  return row.id
}

async function markTurnsSuperseded(ccSessionId, compactId, turnRangeStart, turnRangeEnd) {
  if (!ENABLED) return _disabled('markTurnsSuperseded')
  await db`
    UPDATE os_conversation
    SET superseded_by_compact_id = ${compactId}
    WHERE cc_session_id = ${ccSessionId}
      AND turn_number BETWEEN ${turnRangeStart} AND ${turnRangeEnd}
  `
  return null
}

module.exports = { logTurn, getRecentTurns, getNextTurnNumber, logCompact, markTurnsSuperseded }
