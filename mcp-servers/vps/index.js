#!/usr/bin/env node
/**
 * VPS MCP Server — Shell commands + PM2 management.
 * Runs commands locally (since CC runs ON the VPS).
 * Uses execFile for safety where possible.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_CWD = process.env.VPS_DEFAULT_CWD || '/home/tate'
const MAX_OUTPUT = 50000 // 50KB max output per command

function truncate(str, max = MAX_OUTPUT) {
  if (str.length <= max) return str
  return str.slice(0, max) + `\n... (truncated, ${str.length} total chars)`
}

const server = new McpServer({
  name: 'vps',
  version: '1.0.0',
})

server.tool('shell_exec', {
  description: 'Execute a shell command on the VPS. Returns stdout and stderr. Use for diagnostics, git operations, file inspection, etc.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: `Working directory (default: ${DEFAULT_CWD})` },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
    },
    required: ['command'],
  },
}, async ({ command, cwd, timeout = 30000 }) => {
  try {
    // Use bash -c for shell features (pipes, redirection, etc.)
    const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], {
      cwd: cwd || DEFAULT_CWD,
      timeout,
      maxBuffer: 1024 * 1024, // 1MB
      env: process.env,
    })
    const output = [
      stdout ? `stdout:\n${truncate(stdout)}` : '',
      stderr ? `stderr:\n${truncate(stderr)}` : '',
    ].filter(Boolean).join('\n\n')
    return { content: [{ type: 'text', text: output || '(no output)' }] }
  } catch (err) {
    const output = [
      err.stdout ? `stdout:\n${truncate(err.stdout)}` : '',
      err.stderr ? `stderr:\n${truncate(err.stderr)}` : '',
      `exit code: ${err.code || 'unknown'}`,
      err.killed ? '(process killed — timeout or signal)' : '',
    ].filter(Boolean).join('\n\n')
    return { content: [{ type: 'text', text: `Command failed:\n${output}` }] }
  }
})

server.tool('pm2_list', {
  description: 'List all PM2 processes with their status, CPU, memory, uptime.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
}, async () => {
  try {
    const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10000, maxBuffer: 1024 * 1024 })
    const processes = JSON.parse(stdout)
    const summary = processes.map(p => ({
      name: p.name,
      status: p.pm2_env?.status,
      pid: p.pid,
      cpu: p.monit?.cpu,
      memory: p.monit?.memory ? `${Math.round(p.monit.memory / 1024 / 1024)}MB` : 'N/A',
      uptime: p.pm2_env?.pm_uptime ? `${Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000)}min` : 'N/A',
      restarts: p.pm2_env?.restart_time,
    }))
    return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `PM2 error: ${err.message}` }] }
  }
})

server.tool('pm2_restart', {
  description: 'Restart a PM2 process by name.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'PM2 process name (e.g. "ecodia-api", "organism")' },
    },
    required: ['name'],
  },
}, async ({ name }) => {
  try {
    const { stdout } = await execFileAsync('pm2', ['restart', name], { timeout: 15000 })
    return { content: [{ type: 'text', text: truncate(stdout) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `PM2 restart failed: ${err.stderr || err.message}` }] }
  }
})

server.tool('pm2_logs', {
  description: 'Get recent log output from a PM2 process.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'PM2 process name' },
      lines: { type: 'number', description: 'Number of lines (default 50)' },
    },
    required: ['name'],
  },
}, async ({ name, lines = 50 }) => {
  try {
    const { stdout } = await execFileAsync('pm2', ['logs', name, '--nostream', '--lines', String(lines)], {
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    return { content: [{ type: 'text', text: truncate(stdout) }] }
  } catch (err) {
    return { content: [{ type: 'text', text: `PM2 logs error: ${err.stderr || err.message}` }] }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
