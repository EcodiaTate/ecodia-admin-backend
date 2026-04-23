#!/usr/bin/env node
'use strict';

/**
 * stale-schedule-audit.js
 *
 * PostToolUse harness hook. Fires after approve_factory_deploy or
 * reject_factory_session. Reads the hook payload from stdin, extracts
 * the sessionId, finds any active delayed scheduled tasks whose prompt
 * references that sessionId, and cancels them so duplicate reviews
 * don't fire hours later on already-closed work.
 *
 * Errors: always exit 0 (never block the harness). Logs to stderr.
 */

require('dotenv').config({ path: '/home/tate/ecodiaos/.env' });

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const LOG_KEY = 'ceo.stale_schedule_audit_log';
const MAX_LOG_ENTRIES = 200;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  process.stderr.write('stale-schedule-audit: missing SUPABASE_URL or SUPABASE_SERVICE_KEY\n');
  process.exit(0);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf-8').trim();
}

async function main() {
  const raw = await readStdin();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.stderr.write('stale-schedule-audit: failed to parse stdin JSON\n');
    process.exit(0);
  }

  const sessionId = payload?.tool_input?.sessionId;
  const toolName = payload?.tool_name || '';

  if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
    process.exit(0);
  }

  // Find active delayed tasks whose prompt references this sessionId
  const { data: tasks, error: queryErr } = await supabase
    .from('os_scheduled_tasks')
    .select('id, name, next_run_at')
    .eq('status', 'active')
    .eq('type', 'delayed')
    .ilike('prompt', `%${sessionId}%`);

  if (queryErr) {
    process.stderr.write(`stale-schedule-audit: query error: ${queryErr.message}\n`);
    process.exit(0);
  }

  if (!tasks || tasks.length === 0) {
    process.exit(0);
  }

  // Cancel the matched tasks
  const { error: updateErr } = await supabase
    .from('os_scheduled_tasks')
    .update({ status: 'cancelled', updated_at: new Date().toISOString() })
    .in('id', tasks.map(t => t.id));

  if (updateErr) {
    process.stderr.write(`stale-schedule-audit: update error: ${updateErr.message}\n`);
    process.exit(0);
  }

  // Append to audit log in kv_store
  const ts = new Date().toISOString();
  const entry = {
    ts,
    sessionId,
    toolName,
    cancelled: tasks.map(t => ({ id: t.id, name: t.name, next_run_at: t.next_run_at })),
  };

  try {
    const { data: kvRow } = await supabase
      .from('kv_store')
      .select('value')
      .eq('key', LOG_KEY)
      .maybeSingle();

    let log = [];
    if (Array.isArray(kvRow?.value)) {
      log = kvRow.value;
    }
    log.push(entry);
    if (log.length > MAX_LOG_ENTRIES) log = log.slice(-MAX_LOG_ENTRIES);

    await supabase
      .from('kv_store')
      .upsert({ key: LOG_KEY, value: log, updated_at: ts }, { onConflict: 'key' });
  } catch (logErr) {
    process.stderr.write(`stale-schedule-audit: audit log write failed (non-fatal): ${logErr.message}\n`);
  }

  // Emit harness-compatible output
  const names = tasks.map(t => t.name).join(', ');
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `STALE-SCHEDULE AUDIT: cancelled ${tasks.length} scheduled reviews for session ${sessionId} (${names})`,
    },
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

main().catch(err => {
  process.stderr.write(`stale-schedule-audit: fatal: ${err.message}\n`);
  process.exit(0);
});
