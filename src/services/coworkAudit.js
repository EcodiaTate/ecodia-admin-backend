/**
 * Cowork V2 MCP — write-audit log helper.
 *
 * Spec: ~/ecodiaos/drafts/cowork-deep-integration-architecture-2026-04-30.md §5.2.
 *
 * Authored: 30 Apr 2026 by fork_mokmorc8_24edea (W2-B).
 */
'use strict'

const db = require('../config/db')
const logger = require('../config/logger')

async function logWrite(req, toolName, affected = {}) {
  if (!toolName) return
  try {
    await db`
      INSERT INTO cowork_audit_log (
        cowork_session_id, tool_name, scope_used,
        request_summary, response_summary,
        affected_substrate, affected_row_ref,
        bearer_fingerprint, client_ip
      ) VALUES (
        ${affected.cowork_session_id || null},
        ${toolName},
        ${affected.scope_used || null},
        ${affected.request_summary ? JSON.stringify(affected.request_summary) : null},
        ${affected.response_summary ? JSON.stringify(affected.response_summary) : null},
        ${affected.affected_substrate || null},
        ${affected.affected_row_ref || null},
        ${req?.coworkBearerFingerprint || null},
        ${req?.ip || null}
      )
    `
  } catch (err) {
    logger.warn('coworkAudit.logWrite failed (non-fatal)', {
      error: err.message,
      tool: toolName,
    })
  }
}

module.exports = { logWrite }
