#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_CWD = process.env.VPS_DEFAULT_CWD || '/home/tate'
const MAX_OUTPUT = 50000

function truncate(str, max = MAX_OUTPUT) {
  if (str.length <= max) return str
  return str.slice(0, max) + `\n... (truncated, ${str.length} total chars)`
}

const server = new McpServer({ name: 'vps', version: '1.0.0' })

server.tool('shell_exec',
  'Execute a shell command on the VPS.',
  { command: z.string(), cwd: z.string().optional().describe(`Working directory (default: ${DEFAULT_CWD})`), timeout: z.number().default(30000) },
  async ({ command, cwd, timeout }) => {
    try {
      const { stdout, stderr } = await execFileAsync('/bin/bash', ['-c', command], { cwd: cwd || DEFAULT_CWD, timeout, maxBuffer: 1024 * 1024, env: process.env })
      const output = [stdout ? `stdout:\n${truncate(stdout)}` : '', stderr ? `stderr:\n${truncate(stderr)}` : ''].filter(Boolean).join('\n\n')
      return { content: [{ type: 'text', text: output || '(no output)' }] }
    } catch (err) {
      const output = [err.stdout ? `stdout:\n${truncate(err.stdout)}` : '', err.stderr ? `stderr:\n${truncate(err.stderr)}` : '', `exit code: ${err.code || 'unknown'}`].filter(Boolean).join('\n\n')
      return { content: [{ type: 'text', text: `Command failed:\n${output}` }] }
    }
  }
)

server.tool('pm2_list',
  'List all PM2 processes with status, CPU, memory, uptime.',
  {},
  async () => {
    try {
      const { stdout } = await execFileAsync('pm2', ['jlist'], { timeout: 10000, maxBuffer: 1024 * 1024 })
      const processes = JSON.parse(stdout)
      const summary = processes.map(p => ({ name: p.name, status: p.pm2_env?.status, pid: p.pid, cpu: p.monit?.cpu, memory: p.monit?.memory ? `${Math.round(p.monit.memory / 1024 / 1024)}MB` : 'N/A', uptime: p.pm2_env?.pm_uptime ? `${Math.round((Date.now() - p.pm2_env.pm_uptime) / 60000)}min` : 'N/A', restarts: p.pm2_env?.restart_time }))
      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `PM2 error: ${err.message}` }] }
    }
  }
)

server.tool('pm2_restart',
  'Restart a PM2 process by name.',
  { name: z.string().describe('PM2 process name') },
  async ({ name }) => {
    try {
      const { stdout } = await execFileAsync('pm2', ['restart', name], { timeout: 15000 })
      return { content: [{ type: 'text', text: truncate(stdout) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `PM2 restart failed: ${err.stderr || err.message}` }] }
    }
  }
)

server.tool('pm2_logs',
  'Get recent log output from a PM2 process.',
  { name: z.string(), lines: z.number().default(50) },
  async ({ name, lines }) => {
    try {
      const { stdout } = await execFileAsync('pm2', ['logs', name, '--nostream', '--lines', String(lines)], { timeout: 10000, maxBuffer: 1024 * 1024 })
      return { content: [{ type: 'text', text: truncate(stdout) }] }
    } catch (err) {
      return { content: [{ type: 'text', text: `PM2 logs error: ${err.stderr || err.message}` }] }
    }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
