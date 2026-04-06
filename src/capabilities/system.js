const registry = require('../services/capabilityRegistry')
const env = require('../config/env')

// ═══════════════════════════════════════════════════════════════════════
// SYSTEM CAPABILITIES — Self-Introspection & Quick Operations
//
// These give the system (and the organism) the ability to inspect its
// own state, run quick shell commands, read files, and query its own
// database — without spinning up a full CC session for trivial ops.
//
// This is the difference between "I need to check a log" taking 30s
// vs 3 minutes through Factory.
// ═══════════════════════════════════════════════════════════════════════

registry.registerMany([
  // ─── Filesystem Read ─────────────────────────────────────────────
  {
    name: 'read_file',
    description: 'Read a file from any codebase or system path (logs, configs, source). Returns content or error.',
    tier: 'read',
    domain: 'system',
    params: {
      path: { type: 'string', required: true, description: 'Absolute file path to read' },
      lines: { type: 'number', required: false, description: 'Max lines to return (default: 500, 0 = all)' },
      offset: { type: 'number', required: false, description: 'Start from this line number (0-based)' },
    },
    handler: async (params) => {
      const fs = require('fs')
      const content = fs.readFileSync(params.path, 'utf-8')
      const lines = content.split('\n')
      const offset = params.offset || 0
      const limit = params.lines || 500
      const sliced = limit > 0 ? lines.slice(offset, offset + limit) : lines.slice(offset)
      return {
        content: sliced.join('\n'),
        totalLines: lines.length,
        returned: sliced.length,
        path: params.path,
      }
    },
  },

  // ─── List Directory ──────────────────────────────────────────────
  {
    name: 'list_directory',
    description: 'List files and directories at a path. Useful for discovering codebase structure.',
    tier: 'read',
    domain: 'system',
    params: {
      path: { type: 'string', required: true, description: 'Directory path to list' },
      recursive: { type: 'boolean', required: false, description: 'List recursively (max 3 levels deep)' },
    },
    handler: async (params) => {
      const fs = require('fs')
      const path = require('path')

      function listDir(dir, depth = 0, maxDepth = 3) {
        if (depth >= maxDepth) return []
        const entries = fs.readdirSync(dir, { withFileTypes: true })
        const results = []
        for (const entry of entries) {
          if (['node_modules', '.git', '__pycache__', '.next', 'dist', '.venv', 'venv'].includes(entry.name)) continue
          const full = path.join(dir, entry.name)
          results.push({
            name: entry.name,
            type: entry.isDirectory() ? 'dir' : 'file',
            path: full,
          })
          if (entry.isDirectory() && params.recursive) {
            results.push(...listDir(full, depth + 1, maxDepth))
          }
        }
        return results
      }

      const entries = listDir(params.path)
      return { entries, count: entries.length, path: params.path }
    },
  },

  // ─── Shell Command ───────────────────────────────────────────────
  {
    name: 'run_shell_command',
    description: 'Run a shell command on the VPS. Backend code is at ~/ecodiaos/ (Node/Express, no Prisma — uses raw postgres.js). Python organism is at ~/organism/. PM2 manages processes. For quick operations: checking logs, service status, disk space, git status, process info. NOT for code changes.',
    tier: 'write',
    domain: 'system',
    priority: 'critical',  // always allowed — needed for diagnostics even under pressure
    params: {
      command: { type: 'string', required: true, description: 'Shell command to execute' },
      cwd: { type: 'string', required: false, description: 'Working directory (default: home)' },
      timeout: { type: 'number', required: false, description: 'Timeout in ms (default: 30000)' },
    },
    handler: async (params) => {
      // execSync is intentional — this capability is designed for ad-hoc admin commands
      // on the VPS where shell features (pipes, globs, env expansion) are needed.
      // Input comes from the AI (Cortex/organism), not external users.
      const { execSync } = require('child_process') // eslint-disable-line security/detect-child-process
      const timeout = params.timeout || 30_000
      const cwd = params.cwd || process.env.HOME || '/home/tate'

      try {
        const output = execSync(params.command, {
          cwd,
          encoding: 'utf-8',
          timeout,
          maxBuffer: 5 * 1024 * 1024,
        })
        return { output: output.slice(0, 10_000), exitCode: 0, command: params.command, cwd }
      } catch (err) {
        // execSync throws on non-zero exit — return stderr/stdout as data, not an error.
        // The caller (Cortex, organism) needs to see the output to diagnose, not get a 500.
        return {
          output: (err.stdout || '').slice(0, 5_000),
          stderr: (err.stderr || '').slice(0, 5_000),
          exitCode: err.status ?? 1,
          command: params.command,
          cwd,
        }
      }
    },
  },

  // ─── Query Own Database ──────────────────────────────────────────
  {
    name: 'query_database',
    description: `Run a read-only SQL query against the EcodiaOS database. For diagnostics: checking session counts, error patterns, action queue state, integration health.

IMPORTANT — use exact table names (there is NO table called "goals"):
Core: clients, projects, tasks, pipeline_events, transactions, notifications, app_errors
Sessions: cc_sessions, cc_session_logs, cortex_sessions, cortex_context, os_task_sessions
Factory: factory_learnings, factory_dispatch_log, validation_runs, deployments
Organism: organism_goals, organism_self_model, introspection_logs, growth_journal, scheduled_tasks
Actions: action_queue, action_decisions, direct_actions, event_bus_log
CRM: crm_activity_log, crm_contacts
Email/Social: email_threads, gmail_sync_state, linkedin_profiles, linkedin_posts, linkedin_dms, linkedin_session, linkedin_connection_requests, linkedin_network_snapshots, linkedin_content_themes, linkedin_scrape_log, linkedin_engagement_watchlist, linkedin_engagement_queue
Calendar: calendar_events, calendar_sync_state
Coding: codebases, code_chunks, code_requests, secret_blocklist
Bookkeeping: gl_accounts, staged_transactions, ledger_transactions, ledger_lines, bk_receipts, supplier_rules, accounting_periods, audit_log, bank_reconciliation
Infrastructure: worker_heartbeats, deepseek_usage, playwright_runs, symbridge_messages, _migrations
Google/Vercel/Meta: drive_files, drive_sync_state, vercel_projects, vercel_deployments, meta_pages, meta_posts, meta_conversations, meta_messages
Context: dismissed_items, resolved_issues, user_preferences, conversation_context
OS Cortex: os_docs, os_core_context
Discard: discard_rules`,
    tier: 'read',
    domain: 'system',
    params: {
      query: { type: 'string', required: true, description: 'SQL SELECT query (read-only, no mutations). Use exact table names from the capability description.' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const query = params.query.trim()

      // Safety: only allow SELECT and WITH (CTE) queries
      const normalized = query.toUpperCase().replace(/\s+/g, ' ').trim()
      if (!normalized.startsWith('SELECT') && !normalized.startsWith('WITH')) {
        throw new Error('Only SELECT/WITH queries allowed via this capability. Use Factory CC sessions for mutations.')
      }

      const env = require('../config/env')
      const resultLimit = parseInt(env.CAPABILITY_QUERY_DATABASE_RESULT_LIMIT || '0')
      const rows = await db.unsafe(query)
      const capped = resultLimit > 0 ? rows.slice(0, resultLimit) : rows
      return {
        rows: capped,
        rowCount: rows.length,
        truncated: resultLimit > 0 && rows.length > resultLimit,
      }
    },
  },

  // ─── Get System Health ───────────────────────────────────────────
  {
    name: 'get_system_health',
    description: 'Comprehensive system health check: PM2 processes, disk space, memory, database connectivity, Redis, Neo4j, organism reachability, active CC sessions.',
    tier: 'read',
    domain: 'system',
    params: {},
    handler: async () => {
      const { execFileSync } = require('child_process')
      const db = require('../config/db')
      const bridge = require('../services/factoryBridge')

      const health = {
        activeCCSessions: await bridge.getActiveSessionCount(),
        rateLimitStatus: await bridge.getRateLimitStatus(),
        factoryRunnerHealth: await bridge.getRunnerHealth(),
      }

      // PM2 processes
      try {
        const pm2Output = execFileSync('pm2', ['jlist'], { encoding: 'utf-8', timeout: 10_000 })
        const processes = JSON.parse(pm2Output)
        health.pm2 = processes.map(p => ({
          name: p.name,
          status: p.pm2_env?.status,
          restarts: p.pm2_env?.restart_time,
          uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
          memory: p.monit?.memory,
          cpu: p.monit?.cpu,
        }))
      } catch (err) {
        health.pm2 = { error: err.message }
      }

      // Disk space
      try {
        health.disk = execFileSync('df', ['-h', '/', '/home'], { encoding: 'utf-8', timeout: 5_000 }).trim()
      } catch (err) {
        health.disk = { error: err.message }
      }

      // DB connectivity + basic stats
      try {
        const [dbStats] = await db`
          SELECT
            (SELECT count(*)::int FROM cc_sessions WHERE status = 'running') AS running_sessions,
            (SELECT count(*)::int FROM cc_sessions WHERE started_at > now() - interval '24 hours') AS sessions_24h,
            (SELECT count(*)::int FROM app_errors WHERE created_at > now() - interval '1 hour') AS errors_1h,
            (SELECT count(*)::int FROM action_queue WHERE status = 'pending') AS pending_actions
        `
        health.database = { connected: true, ...dbStats }
      } catch (err) {
        health.database = { connected: false, error: err.message }
      }

      // Redis
      try {
        const { getRedisClient } = require('../config/redis')
        const redis = getRedisClient()
        if (redis) {
          await redis.ping()
          health.redis = { connected: true }
        } else {
          health.redis = { connected: false, error: 'No Redis client' }
        }
      } catch (err) {
        health.redis = { connected: false, error: err.message }
      }

      // Organism reachability
      try {
        const env = require('../config/env')
        const orgUrl = env.ORGANISM_API_URL || 'http://localhost:8000'
        const resp = await fetch(`${orgUrl}/health`, { signal: AbortSignal.timeout(5000) })
        health.organism = { reachable: resp.ok, status: resp.status }
      } catch (err) {
        health.organism = { reachable: false, error: err.message }
      }

      return health
    },
  },

  // ─── Get Recent Errors ───────────────────────────────────────────
  {
    name: 'get_recent_errors',
    description: 'Fetch recent application errors from the error log. For diagnosing issues, understanding failure patterns, and deciding what Factory sessions to dispatch.',
    tier: 'read',
    domain: 'system',
    params: {
      hours: { type: 'number', required: false, description: 'Look back this many hours (default: 6)' },
      limit: { type: 'number', required: false, description: 'Max errors to return (default: 20)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const hours = params.hours || 6
      const limit = params.limit || 20

      const errors = await db`
        SELECT id, level, message, meta, created_at
        FROM app_errors
        WHERE created_at > now() - make_interval(hours => ${hours})
        ORDER BY created_at DESC
        LIMIT ${limit}
      `
      return { errors, count: errors.length, lookback: `${hours}h` }
    },
  },

  // ─── Get Factory Learnings ───────────────────────────────────────
  {
    name: 'get_factory_learnings',
    description: 'View accumulated Factory learnings for a codebase or globally. Useful for understanding what patterns succeed/fail before dispatching sessions.',
    tier: 'read',
    domain: 'system',
    params: {
      codebaseName: { type: 'string', required: false, description: 'Filter to a specific codebase (omit for global + all)' },
    },
    handler: async (params) => {
      const db = require('../config/db')

      let learnings
      if (params.codebaseName) {
        learnings = await db`
          SELECT fl.id, fl.pattern_type, fl.pattern_description, fl.confidence,
                 fl.times_applied, fl.last_applied_at, fl.success, fl.created_at,
                 cb.name AS codebase_name
          FROM factory_learnings fl
          LEFT JOIN codebases cb ON fl.codebase_id = cb.id
          WHERE cb.name ILIKE ${params.codebaseName}
          ORDER BY fl.confidence DESC, fl.updated_at DESC
          LIMIT 30
        `
      } else {
        learnings = await db`
          SELECT fl.id, fl.pattern_type, fl.pattern_description, fl.confidence,
                 fl.times_applied, fl.last_applied_at, fl.success, fl.created_at,
                 cb.name AS codebase_name
          FROM factory_learnings fl
          LEFT JOIN codebases cb ON fl.codebase_id = cb.id
          ORDER BY fl.confidence DESC, fl.updated_at DESC
          LIMIT 50
        `
      }
      return { learnings, count: learnings.length }
    },
  },

  // ─── Send Message to Running CC Session ──────────────────────────
  {
    name: 'send_cc_message',
    description: 'Send a follow-up message to a running CC session. Use this to provide additional context, redirect the session, or answer questions the CC session is asking.',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      sessionId: { type: 'number', required: true, description: 'CC session ID to message' },
      content: { type: 'string', required: true, description: 'Message content to send' },
    },
    handler: async (params) => {
      const bridge = require('../services/factoryBridge')
      bridge.publishSendMessage(params.sessionId, params.content)
      return { message: `Message sent to session ${params.sessionId}` }
    },
  },

  // ─── Get Active CC Session Details ───────────────────────────────
  {
    name: 'get_cc_session_details',
    description: 'Get detailed info about a CC session including logs, status, pipeline stage, files changed, and confidence score.',
    tier: 'read',
    domain: 'factory',
    params: {
      sessionId: { type: 'number', required: true, description: 'CC session ID' },
    },
    handler: async (params) => {
      const db = require('../config/db')

      const [session] = await db`
        SELECT cs.*, cb.name AS codebase_name, cb.repo_path
        FROM cc_sessions cs
        LEFT JOIN codebases cb ON cs.codebase_id = cb.id
        WHERE cs.id = ${params.sessionId}
      `
      if (!session) throw new Error(`Session ${params.sessionId} not found`)

      const logs = await db`
        SELECT chunk, created_at FROM cc_session_logs
        WHERE session_id = ${params.sessionId}
        ORDER BY id DESC LIMIT 50
      `

      // Determine if running via heartbeat (session runs in factoryRunner process)
      const isActive = session.status === 'running' &&
        session.last_heartbeat_at && (Date.now() - new Date(session.last_heartbeat_at).getTime() < 120_000)

      return {
        ...session,
        isRunning: isActive,
        runningFor: isActive && session.started_at ? Date.now() - new Date(session.started_at).getTime() : null,
        recentLogs: logs.reverse(),
      }
    },
  },

  // ─── List Registered Codebases ───────────────────────────────────
  {
    name: 'list_codebases',
    description: 'List all registered codebases the Factory can target, including their paths, languages, and deploy configs.',
    tier: 'read',
    domain: 'factory',
    params: {},
    handler: async () => {
      const db = require('../config/db')
      const codebases = await db`
        SELECT id, name, language, repo_path, meta, created_at
        FROM codebases ORDER BY name
      `
      return { codebases, count: codebases.length }
    },
  },

  // ─── Dispatch Parallel CC Sessions ───────────────────────────────
  {
    name: 'start_parallel_cc_sessions',
    description: 'Dispatch multiple CC sessions simultaneously for related but independent tasks. Each gets its own context bundle and oversight pipeline.',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      sessions: { type: 'string', required: true, description: 'JSON array of {prompt, codebaseName?, codebaseId?} objects' },
    },
    handler: async (params) => {
      const triggers = require('../services/factoryTriggerService')
      let specs
      try {
        specs = JSON.parse(params.sessions)
      } catch {
        throw new Error('sessions must be a valid JSON array of {prompt, codebaseName?, codebaseId?}')
      }

      if (!Array.isArray(specs) || specs.length === 0) {
        throw new Error('sessions must be a non-empty array')
      }

      // Concurrency is env-driven (0 = unlimited). The AI decides how many it needs.
      const maxParallel = parseInt(env.CC_MAX_PARALLEL_SESSIONS || '0', 10)
      const capped = maxParallel > 0 ? specs.slice(0, maxParallel) : specs
      const results = await Promise.allSettled(
        capped.map(spec => triggers.dispatchFromCortex(spec.prompt, {
          codebaseId: spec.codebaseId,
          codebaseName: spec.codebaseName,
        }))
      )

      return {
        dispatched: results.filter(r => r.status === 'fulfilled').length,
        failed: results.filter(r => r.status === 'rejected').length,
        sessions: results.map((r, i) => ({
          prompt: capped[i].prompt.slice(0, 80),
          status: r.status,
          sessionId: r.status === 'fulfilled' ? r.value?.id : null,
          error: r.status === 'rejected' ? r.reason?.message : null,
        })),
      }
    },
  },

  // ─── Write File ─────────────────────────────────────────────────
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it does not exist, overwrites if it does. For quick fixes without spinning up a full Factory session.',
    tier: 'write',
    domain: 'system',
    params: {
      path: { type: 'string', required: true, description: 'Absolute file path to write' },
      content: { type: 'string', required: true, description: 'File content to write' },
    },
    handler: async (params) => {
      const fs = require('fs')
      const path = require('path')
      // Ensure parent directory exists
      const dir = path.dirname(params.path)
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true })
      }
      fs.writeFileSync(params.path, params.content, 'utf-8')
      return { written: true, path: params.path, bytes: Buffer.byteLength(params.content) }
    },
  },

  // ─── Edit File (patch) ──────────────────────────────────────────
  {
    name: 'edit_file',
    description: 'Replace a specific string in a file. For surgical edits without spinning up a full Factory session.',
    tier: 'write',
    domain: 'system',
    params: {
      path: { type: 'string', required: true, description: 'Absolute file path to edit' },
      old_string: { type: 'string', required: true, description: 'Exact string to find and replace' },
      new_string: { type: 'string', required: true, description: 'Replacement string' },
      replace_all: { type: 'boolean', required: false, description: 'Replace all occurrences (default: false)' },
    },
    handler: async (params) => {
      const fs = require('fs')
      let content = fs.readFileSync(params.path, 'utf-8')
      const count = (content.match(new RegExp(params.old_string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length
      if (count === 0) throw new Error(`String not found in ${params.path}`)
      if (params.replace_all) {
        content = content.split(params.old_string).join(params.new_string)
      } else {
        content = content.replace(params.old_string, params.new_string)
      }
      fs.writeFileSync(params.path, content, 'utf-8')
      return { edited: true, path: params.path, replacements: params.replace_all ? count : 1 }
    },
  },

  // ─── Execute Database Mutation ──────────────────────────────────
  {
    name: 'execute_database',
    description: `Execute a SQL mutation (INSERT, UPDATE, DELETE, ALTER, CREATE) against the EcodiaOS database. For operational fixes, data corrections, and schema changes without a full Factory session.

IMPORTANT — use exact table names (there is NO table called "goals"):
Core: clients, projects, tasks, pipeline_events, transactions, notifications, app_errors
Sessions: cc_sessions, cc_session_logs, cortex_sessions, cortex_context, os_task_sessions
Factory: factory_learnings, factory_dispatch_log, validation_runs, deployments
Organism: organism_goals, organism_self_model, introspection_logs, growth_journal, scheduled_tasks
Actions: action_queue, action_decisions, direct_actions, event_bus_log
CRM: crm_activity_log, crm_contacts
Coding: codebases, code_chunks, code_requests, secret_blocklist
Bookkeeping: gl_accounts, staged_transactions, ledger_transactions, ledger_lines, bk_receipts, supplier_rules, accounting_periods, audit_log, bank_reconciliation
Infrastructure: worker_heartbeats, deepseek_usage, playwright_runs, symbridge_messages, _migrations`,
    tier: 'write',
    domain: 'system',
    priority: 'critical',
    params: {
      query: { type: 'string', required: true, description: 'SQL statement to execute. Use exact table names from the capability description.' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const result = await db.unsafe(params.query)
      return {
        executed: true,
        rowCount: result.count ?? result.length ?? 0,
      }
    },
  },

  // ─── Self-Diagnosis ─────────────────────────────────────────────
  {
    name: 'self_diagnose',
    description: 'Dispatch a Factory session to investigate and fix an error in the Factory itself. The session gets full access to the EcodiaOS backend codebase.',
    tier: 'write',
    domain: 'factory',
    priority: 'critical',
    params: {
      description: { type: 'string', required: true, description: 'What went wrong and what needs investigating' },
      error: { type: 'string', required: false, description: 'Error message or stack trace' },
      service: { type: 'string', required: false, description: 'Which service is affected' },
    },
    handler: async (params) => {
      const triggers = require('../services/factoryTriggerService')
      const session = await triggers.dispatchSelfDiagnosis(params)
      return { dispatched: true, sessionId: session?.id }
    },
  },

  // ─── Proactive Improvement ──────────────────────────────────────
  {
    name: 'proactive_improve',
    description: 'Dispatch a Factory session to proactively improve code quality in a codebase. Finds and fixes bugs, fragile patterns, performance issues, and missing edge cases.',
    tier: 'write',
    domain: 'factory',
    params: {
      description: { type: 'string', required: true, description: 'What to investigate or improve' },
      codebaseName: { type: 'string', required: false, description: 'Target codebase name' },
      files: { type: 'string', required: false, description: 'JSON array of file paths to focus on' },
    },
    handler: async (params) => {
      const triggers = require('../services/factoryTriggerService')
      const files = params.files ? JSON.parse(params.files) : undefined
      const session = await triggers.dispatchProactiveImprovement({
        description: params.description,
        codebaseName: params.codebaseName,
        files,
      })
      return { dispatched: true, sessionId: session?.id }
    },
  },
])
