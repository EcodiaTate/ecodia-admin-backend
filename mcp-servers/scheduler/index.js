#!/usr/bin/env node
/**
 * Scheduler MCP Server — persistent, database-backed task scheduling.
 * 
 * Two responsibilities:
 * 1. MCP tools for creating/managing scheduled tasks
 * 2. Background polling loop that fires due tasks at the OS session
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import postgres from 'postgres'

const db = postgres(process.env.DATABASE_URL, { max: 3, idle_timeout: 30 })
const API_PORT = process.env.PORT || 3001
const POLL_INTERVAL = 30_000 // 30 seconds

const server = new McpServer({ name: 'scheduler', version: '1.0.0' })

// ── Parse human-readable schedules ──

function parseSchedule(schedule) {
  // "every 30m", "every 2h", "every 72h", "daily 09:00"
  const everyMatch = schedule.match(/^every\s+(\d+)(m|h)$/i)
  if (everyMatch) {
    const val = parseInt(everyMatch[1])
    const unit = everyMatch[2].toLowerCase()
    const ms = unit === 'm' ? val * 60000 : val * 3600000
    return { type: 'interval', ms }
  }
  const dailyMatch = schedule.match(/^daily\s+(\d{1,2}):(\d{2})$/i)
  if (dailyMatch) {
    return { type: 'daily', hour: parseInt(dailyMatch[1]), minute: parseInt(dailyMatch[2]) }
  }
  return null
}

function computeNextRun(cronExpr) {
  const parsed = parseSchedule(cronExpr)
  if (!parsed) return null
  const now = new Date()
  if (parsed.type === 'interval') {
    return new Date(now.getTime() + parsed.ms)
  }
  if (parsed.type === 'daily') {
    const next = new Date(now)
    next.setUTCHours(parsed.hour, parsed.minute, 0, 0)
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1)
    return next
  }
  return null
}

// ── MCP Tools ──

server.tool('schedule_cron', 'Create a recurring scheduled task', {
  name: z.string().describe('Unique task name'),
  schedule: z.string().describe('Schedule: "every 30m", "every 2h", "daily 09:00"'),
  prompt: z.string().describe('The prompt to fire when task is due'),
}, async ({ name, schedule, prompt }) => {
  const parsed = parseSchedule(schedule)
  if (!parsed) return { content: [{ type: 'text', text: `Can't parse schedule: "${schedule}". Use "every Xm", "every Xh", "daily HH:MM".` }] }
  const nextRun = computeNextRun(schedule)
  const [row] = await db`
    INSERT INTO os_scheduled_tasks (type, name, prompt, cron_expression, status, next_run_at, run_count, max_runs)
    VALUES ('cron', ${name}, ${prompt}, ${schedule}, 'active', ${nextRun}, 0, 0)
    RETURNING id, next_run_at
  `
  return { content: [{ type: 'text', text: `Cron "${name}" created. Next run: ${row.next_run_at}. Schedule: ${schedule}. Runs indefinitely.` }] }
})

server.tool('schedule_delayed', 'Create a one-shot delayed task', {
  name: z.string().describe('Task name'),
  delay: z.string().describe('Delay: "in 3d", "in 2h", "in 30m" or ISO datetime'),
  prompt: z.string().describe('The prompt to fire'),
}, async ({ name, delay, prompt }) => {
  let runAt
  const delayMatch = delay.match(/^in\s+(\d+)(m|h|d)$/i)
  if (delayMatch) {
    const val = parseInt(delayMatch[1])
    const unit = delayMatch[2].toLowerCase()
    const ms = unit === 'm' ? val * 60000 : unit === 'h' ? val * 3600000 : val * 86400000
    runAt = new Date(Date.now() + ms)
  } else {
    runAt = new Date(delay)
    if (isNaN(runAt.getTime())) return { content: [{ type: 'text', text: `Can't parse delay: "${delay}"` }] }
  }
  const [row] = await db`
    INSERT INTO os_scheduled_tasks (type, name, prompt, status, run_at, next_run_at, run_count, max_runs)
    VALUES ('delayed', ${name}, ${prompt}, 'active', ${runAt}, ${runAt}, 0, 1)
    RETURNING id, next_run_at
  `
  return { content: [{ type: 'text', text: `Delayed task "${name}" created. Fires at: ${row.next_run_at}` }] }
})

server.tool('schedule_chain', 'Create a task that runs after another completes', {
  name: z.string().describe('Task name'),
  afterTaskId: z.string().describe('UUID of task to run after'),
  prompt: z.string().describe('The prompt to fire'),
}, async ({ name, afterTaskId, prompt }) => {
  const [row] = await db`
    INSERT INTO os_scheduled_tasks (type, name, prompt, chain_after, status, run_count, max_runs)
    VALUES ('chain', ${name}, ${prompt}, ${afterTaskId}, 'active', 0, 1)
    RETURNING id
  `
  return { content: [{ type: 'text', text: `Chained task "${name}" created. Fires after task ${afterTaskId} completes.` }] }
})

server.tool('schedule_list', 'List all scheduled tasks', {
  status: z.string().optional().describe('Filter by status: active, paused, completed, cancelled, all'),
}, async ({ status }) => {
  const filter = status === 'all' ? undefined : (status || 'active')
  const tasks = filter
    ? await db`SELECT * FROM os_scheduled_tasks WHERE status = ${filter} ORDER BY next_run_at NULLS LAST`
    : await db`SELECT * FROM os_scheduled_tasks ORDER BY status, next_run_at NULLS LAST`
  return { content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }] }
})

server.tool('schedule_cancel', 'Cancel a scheduled task', {
  taskId: z.string().describe('Task UUID'),
}, async ({ taskId }) => {
  await db`UPDATE os_scheduled_tasks SET status = 'cancelled' WHERE id = ${taskId}`
  return { content: [{ type: 'text', text: `Task ${taskId} cancelled.` }] }
})

server.tool('schedule_pause', 'Pause a scheduled task', {
  taskId: z.string().describe('Task UUID'),
}, async ({ taskId }) => {
  await db`UPDATE os_scheduled_tasks SET status = 'paused' WHERE id = ${taskId}`
  return { content: [{ type: 'text', text: `Task ${taskId} paused.` }] }
})

server.tool('schedule_resume', 'Resume a paused task', {
  taskId: z.string().describe('Task UUID'),
}, async ({ taskId }) => {
  const nextRun = new Date()
  await db`UPDATE os_scheduled_tasks SET status = 'active', next_run_at = ${nextRun} WHERE id = ${taskId}`
  return { content: [{ type: 'text', text: `Task ${taskId} resumed. Next run: now.` }] }
})

server.tool('schedule_run_now', 'Fire a task immediately', {
  taskId: z.string().describe('Task UUID'),
}, async ({ taskId }) => {
  const [task] = await db`SELECT * FROM os_scheduled_tasks WHERE id = ${taskId}`
  if (!task) return { content: [{ type: 'text', text: 'Task not found.' }] }
  await fireTask(task)
  return { content: [{ type: 'text', text: `Task "${task.name}" fired.` }] }
})

// ── Fire a task — POST to OS session ──

async function fireTask(task) {
  try {
    const prefixed = `[SCHEDULED: ${task.name}] ${task.prompt}`
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: prefixed }),
      signal: AbortSignal.timeout(300_000), // 5 min timeout
    })
    const result = await res.json().catch(() => ({}))
    
    // Update task
    const now = new Date()
    if (task.type === 'cron') {
      const nextRun = computeNextRun(task.cron_expression)
      await db`UPDATE os_scheduled_tasks SET 
        last_run_at = ${now}, 
        next_run_at = ${nextRun}, 
        run_count = run_count + 1,
        result = ${JSON.stringify(result).slice(0, 500)}
      WHERE id = ${task.id}`
    } else {
      // One-shot or chain — mark completed
      await db`UPDATE os_scheduled_tasks SET 
        last_run_at = ${now}, 
        run_count = run_count + 1, 
        status = 'completed',
        result = ${JSON.stringify(result).slice(0, 500)}
      WHERE id = ${task.id}`
      
      // Fire any chained tasks
      const chained = await db`SELECT * FROM os_scheduled_tasks WHERE chain_after = ${task.id} AND status = 'active'`
      for (const c of chained) await fireTask(c)
    }
    
    console.error(`[Scheduler] Fired "${task.name}" — success`)
  } catch (err) {
    console.error(`[Scheduler] Failed to fire "${task.name}": ${err.message}`)
    // Don't mark as failed — just skip this run, try next time
    if (task.type === 'cron') {
      const nextRun = computeNextRun(task.cron_expression)
      await db`UPDATE os_scheduled_tasks SET next_run_at = ${nextRun}, result = ${err.message} WHERE id = ${task.id}`
    }
  }
}

// ── Polling loop — check for due tasks every 30s ──

async function isSessionBusy() {
  try {
    const res = await fetch(`http://127.0.0.1:${API_PORT}/api/os-session/status`, {
      signal: AbortSignal.timeout(5000),
    })
    const status = await res.json()
    return status.active === true || status.status === 'streaming'
  } catch {
    return false // If we can't check, assume not busy
  }
}

async function pollOnce() {
  try {
    const now = new Date()
    const dueTasks = await db`
      SELECT * FROM os_scheduled_tasks
      WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ${now}
      ORDER BY next_run_at
    `
    if (dueTasks.length === 0) return

    // Skip if session is already busy — reschedule overdue tasks
    const busy = await isSessionBusy()
    if (busy) {
      console.error(`[Scheduler] Session busy — skipping ${dueTasks.length} due task(s), will retry next poll`)
      return
    }

    // Only fire one task per poll cycle to avoid flooding
    const task = dueTasks[0]
    await fireTask(task)

    // Reschedule remaining overdue crons to next interval (don't stack them)
    for (const t of dueTasks.slice(1)) {
      if (t.type === 'cron') {
        const nextRun = computeNextRun(t.cron_expression)
        await db`UPDATE os_scheduled_tasks SET next_run_at = ${nextRun} WHERE id = ${t.id}`
        console.error(`[Scheduler] Rescheduled overdue "${t.name}" to ${nextRun}`)
      }
    }
  } catch (err) {
    console.error(`[Scheduler] Poll error: ${err.message}`)
  }
}

// Start polling
setInterval(pollOnce, POLL_INTERVAL)
// Also poll immediately on startup to catch overdue tasks
setTimeout(pollOnce, 5000)

console.error('[Scheduler] Polling loop started (every 30s)')

// ── Connect MCP ──

const transport = new StdioServerTransport()
await server.connect(transport)
