/**
 * forkConductorTool — exposes fork-mode to the conductor as native SDK tools.
 *
 * The conductor is the Claude Agent SDK process; tools registered here appear
 * in its tool list as `mcp__forks__spawn_fork`, `mcp__forks__list_forks`, and
 * `mcp__forks__abort_fork`. They run in-process (no MCP subprocess), share
 * memory with `forkService`, and return immediately — spawn_fork is fire-and-
 * forget from the conductor's perspective.
 *
 * Design: the conductor decides parallelism. It can fan out up to 5 forks for
 * a single request and then go back to its primary work; fork reports land in
 * its inbox via the message queue when each fork finishes.
 */
'use strict'

const logger = require('../config/logger')

// Lazy-load the SDK + zod at first use. Both are CJS-incompatible (SDK is ESM,
// zod is fine but sized) so we only pay the cost when the conductor actually
// spawns. The factory returns the SDK MCP server config object, which is
// passed verbatim into options.mcpServers.forks.
let _serverConfig = null
let _building = null

async function getForkConductorMcpServer() {
  if (_serverConfig) return _serverConfig
  if (_building) return _building

  _building = (async () => {
    const sdk = await import('@anthropic-ai/claude-agent-sdk')
    const { createSdkMcpServer, tool } = sdk
    const z = require('zod')
    const fork = require('./forkService')

    const spawn_fork_tool = tool(
      'spawn_fork',
      'Spawn a parallel fork sub-session that works on `brief` while you continue your own work. Returns immediately with a fork_id. The fork runs independently — it does NOT share state with you, and you cannot talk to it while it works. When it finishes, its [FORK_REPORT] arrives in your inbox as a [SYSTEM: fork_report] queue message on your next turn. Use this whenever a piece of work can run in parallel with whatever else you are doing. You can spawn up to 5 concurrent forks. Each fork costs tokens proportional to its work, so use this for genuinely-parallel work, not for trivial things you would do faster yourself.',
      {
        brief: z.string().min(1).describe('A complete brief describing what the fork should do. The fork will not have your context; write the brief as if you are handing the task to a fresh OS instance — include the goal, any constraints, and what counts as done.'),
        context_mode: z.enum(['recent', 'brief']).optional().default('recent').describe('"recent" (default): fork inherits the recent conversation tail. "brief": fork gets only the brief, no context — use when the brief is self-contained and you want to minimize the fork token cost.'),
      },
      async (args) => {
        try {
          const snap = await fork.spawnFork({ brief: args.brief, context_mode: args.context_mode || 'recent' })
          return {
            content: [{
              type: 'text',
              text: `Fork spawned: ${snap.fork_id}\nstatus: ${snap.status}\nbrief: ${snap.brief}\n\nThe fork is running in parallel. Continue your own work — its [FORK_REPORT] will arrive in your inbox on a future turn. Do not wait for it.`,
            }],
          }
        } catch (err) {
          // Cap-rejected spawns return a recognisable shape so the conductor
          // can decide whether to retry, queue the brief, or hand it back to
          // the user. We surface the error message verbatim — the model is
          // smart enough to read it and adapt.
          const detail = err && err.code
            ? `${err.code}: ${err.message}${err.details ? ' — ' + JSON.stringify(err.details) : ''}`
            : err && err.message ? err.message : String(err)
          return {
            content: [{
              type: 'text',
              text: `Fork spawn rejected — ${detail}\n\nIf cap_reached: wait for an active fork to finish, or do this work yourself. If energy_cap_reached: the weekly Claude Max budget is tight and parallelism is being throttled.`,
            }],
            isError: true,
          }
        }
      },
    )

    const list_forks_tool = tool(
      'list_forks',
      'List all currently-active forks (and recently-finished ones, last 5 min). Use this if you want to know what is running in parallel before deciding to spawn another, or if you want to check on a fork by id.',
      {},
      async () => {
        try {
          const live = fork.listForks()
          if (!live.length) {
            return { content: [{ type: 'text', text: 'No forks running.' }] }
          }
          const rows = live.map(f => {
            const ageSec = f.started_at ? Math.round((Date.now() - new Date(f.started_at).getTime()) / 1000) : 0
            return `- ${f.fork_id} [${f.status}] (${ageSec}s, ${f.tool_calls} tools)\n    brief: ${(f.brief || '').slice(0, 200)}\n    position: ${(f.position || '').slice(0, 200)}${f.result ? '\n    result: ' + (f.result || '').slice(0, 200) : ''}`
          })
          return {
            content: [{
              type: 'text',
              text: `Active forks (${live.length}/${fork.HARD_FORK_CAP}):\n${rows.join('\n')}`,
            }],
          }
        } catch (err) {
          return { content: [{ type: 'text', text: `list_forks error: ${err.message}` }], isError: true }
        }
      },
    )

    const abort_fork_tool = tool(
      'abort_fork',
      'Abort a running fork by id. Use sparingly — the report you would have received is lost. Useful when the same work has been superseded by a later instruction or when a fork is clearly going wrong.',
      {
        fork_id: z.string().describe('The fork id to abort, as returned by spawn_fork.'),
        reason: z.string().optional().describe('Short reason — recorded in the fork registry for post-hoc analysis.'),
      },
      async (args) => {
        try {
          const result = await fork.abortFork(args.fork_id, args.reason || 'conductor_abort')
          if (!result.aborted) {
            return { content: [{ type: 'text', text: `abort_fork: ${result.reason || 'not aborted'}` }] }
          }
          return { content: [{ type: 'text', text: `Fork ${args.fork_id} aborted.` }] }
        } catch (err) {
          return { content: [{ type: 'text', text: `abort_fork error: ${err.message}` }], isError: true }
        }
      },
    )

    const server = createSdkMcpServer({
      name: 'forks',
      version: '1.0.0',
      tools: [spawn_fork_tool, list_forks_tool, abort_fork_tool],
    })

    logger.info('forkConductorTool: in-process MCP server "forks" ready', {
      tools: ['spawn_fork', 'list_forks', 'abort_fork'],
    })
    _serverConfig = server
    return server
  })()

  return _building
}

module.exports = { getForkConductorMcpServer }
