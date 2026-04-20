const registry = require('../services/capabilityRegistry')

// ═══════════════════════════════════════════════════════════════════════
// SELF-OBSERVABILITY CAPABILITIES
//
// The OS's own introspection surface. Use these when you suspect
// something's off, when a turn retried, when the heartbeat grounded
// context looks anomalous, or when Tate asks "is everything ok".
//
// Design principle: the OS reads these, not a human. Results are
// structured JSON, compact, stable keys. No prose summaries — you
// reason about the facts yourself.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  {
    name: 'os_self_check',
    description:
      'Probe every critical subsystem (DB, Redis, Neo4j, Claude quota, cert, heartbeat, factory, recent incidents) and return a structured health snapshot. ' +
      'Use this when you suspect something is wrong, after a retried turn, or before advising Tate that the system is healthy. ' +
      'Cheap (~1s), parallel, never blocks. Returns { status: healthy|degraded|critical, subsystems: {...}, summary: string }.',
    tier: 'read',
    domain: 'system',
    params: {},
    handler: async () => {
      const self = require('../services/osSelfCheckService')
      return self.selfCheck()
    },
  },

  {
    name: 'os_recent_incidents',
    description:
      'Read the structured incident log — every non-success turn and subsystem failure. ' +
      'Use to diagnose repeated problems, find which MCP is flaky, or confirm a fix is holding. ' +
      'Params: hours (default 24), kind (optional filter: turn_failure | mcp_failure | provider_switch | tool_hung | db_error | empty_sdk_stream | etc.), severity (info|warn|error|critical).',
    tier: 'read',
    domain: 'system',
    params: {
      hours: { type: 'number', required: false, description: 'Lookback window, default 24' },
      kind: { type: 'string', required: false, description: 'Filter by incident kind' },
      severity: { type: 'string', required: false, description: 'Filter by severity: info, warn, error, critical' },
      limit: { type: 'number', required: false, description: 'Max rows, default 50' },
    },
    handler: async (params) => {
      const incidents = require('../services/osIncidentService')
      const rows = await incidents.recent({
        hours: params.hours,
        kind: params.kind,
        severity: params.severity,
        limit: params.limit,
      })
      return { count: rows.length, incidents: rows }
    },
  },

  {
    name: 'os_incident_patterns',
    description:
      'Aggregate incident log into patterns (kind + component + severity -> count, first_at, last_at). ' +
      'The right query to lead with when asked "what has been going wrong lately". ' +
      'If the same (kind, component) has N>5 in the last 4h, that subsystem is failing repeatedly and needs attention.',
    tier: 'read',
    domain: 'system',
    params: {
      hours: { type: 'number', required: false, description: 'Lookback window, default 24' },
    },
    handler: async (params) => {
      const incidents = require('../services/osIncidentService')
      const rows = await incidents.patterns({ hours: params.hours })
      return { count: rows.length, patterns: rows }
    },
  },
])
