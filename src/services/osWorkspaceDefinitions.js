/**
 * OS Workspace Definitions — data-driven workspace configs for the OS Cortex.
 * Each workspace defines what the AI sees, what tools it has, and what context it loads.
 * Zero organism imports. Pure configuration.
 */

const WORKSPACES = {
  bookkeeping: {
    name: 'bookkeeping',
    label: 'Bookkeeping',
    description: 'Double-entry bookkeeping, bank imports, categorization, GST, BAS, reports',
    domains: ['bookkeeping', 'crm'],
    autoLoadDocs: ['chart-of-accounts', 'supplier-rules', 'gst-rules', 'ecodia-context'],
    stateQueries: {
      'Pending transactions': `SELECT count(*)::int AS count FROM staged_transactions WHERE status = 'pending'`,
      'Uncategorized': `SELECT count(*)::int AS count FROM staged_transactions WHERE status = 'pending' AND category IS NULL`,
      'Categorized (ready to post)': `SELECT count(*)::int AS count FROM staged_transactions WHERE status = 'categorized'`,
      'Posted total': `SELECT count(*)::int AS count FROM ledger_transactions`,
      'Recent ledger': `SELECT occurred_at, description, source_system FROM ledger_transactions ORDER BY occurred_at DESC LIMIT 5`,
    },
    systemPromptAddition: `You are the bookkeeper for Ecodia Pty Ltd (AU company, GST registered, FY July-June).
All amounts are integer cents (AUD). $79.64 = 7964 cents. Negative = debit/expense.

CSV IMPORT: When given CSV text or a file, use bookkeeping_ingest_csv with the raw text.
The CSV parser is AI-powered — it auto-detects columns from any bank format.

CATEGORIZATION: Match descriptions against supplier-rules doc. If no rule matches, use your judgement + chart of accounts, then CREATE a new rule via update_doc so it auto-matches next time.

DOUBLE-ENTRY: Every journal needs >=2 balanced lines (total debits = total credits).
Common patterns:
  Business expense: DR 5xxx (expense) / CR 1000 (bank)
  Personal on biz card: DR 2100 (director loan) / CR 1000 (bank)
  Income received: DR 1000 (bank) / CR 4xxx (income)
  GST on purchase: DR 2110 (GST paid) / CR 1000 (bank) — split from the expense line

INTERNATIONAL FEES: Bank Australia charges a separate "Int Tran Fee" line for foreign transactions. Categorize to 5045 Bank Fees. The main transaction goes to its normal account.

SEARCH: Use bookkeeping_search_staged/bookkeeping_search_ledger to find specific transactions by keyword or date range.

QUESTIONS: Use question blocks to ask the human when unsure about categorization. Don't guess on ambiguous items — ask.

WHEN TO CREATE ENTRIES:
- Only create journal entries for transactions ALREADY on the bank statement (imported via CSV or Xero).
- Verbal mentions of spending get acknowledged, not journaled.
- Manual journals are for adjustments, corrections, and EOFY closing only.

CORRECTIONS: Never delete posted ledger entries. Use bookkeeping_reverse_entry to create a reversing journal.

PERIOD LOCKING: After lodging BAS or closing EOFY, lock the period with bookkeeping_lock_period.

RECEIPTS: Save receipts with bookkeeping_save_receipt. System auto-matches to bank transactions by amount + date.

CRM INTEGRATION: Link transactions to clients/projects with bookkeeping_link_to_client. View all financial activity for a client or project.

AUTO-LEARNING: The system auto-creates supplier rules from AI categorization. Update supplier-rules doc for manual rules.

REPORTS: P&L, Balance Sheet, BAS/GST, Cash Flow, Expense Breakdown, Trial Balance, Director Loan, Income Tax Estimate. Use quarterly dates for BAS, full FY for annual.`,
  },

  socials: {
    name: 'socials',
    label: 'Socials',
    description: 'Unified inbox — Gmail, LinkedIn, Meta (FB/IG/Messenger). Triage, reply, post, follow-up, cleanup.',
    domains: ['gmail', 'linkedin', 'meta', 'crm'],
    autoLoadDocs: ['ecodia-context', 'team-contacts'],
    stateQueries: {
      'Gmail inbox': `SELECT
        count(*) FILTER (WHERE status = 'unread')::int AS unread,
        count(*) FILTER (WHERE triage_priority = 'urgent' AND status = 'unread')::int AS urgent,
        count(*) FILTER (WHERE triage_priority = 'high' AND status = 'unread')::int AS high,
        count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage
        FROM email_threads WHERE received_at > now() - interval '7 days'`,
      'LinkedIn DMs': `SELECT
        count(*) FILTER (WHERE status = 'unread')::int AS unread,
        count(*) FILTER (WHERE category = 'lead')::int AS leads,
        count(*) FILTER (WHERE priority IN ('urgent','high'))::int AS high_priority
        FROM linkedin_dms`,
      'Meta conversations': `SELECT
        count(*) FILTER (WHERE unread = true)::int AS unread,
        count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage,
        count(DISTINCT platform)::int AS platforms
        FROM meta_conversations`,
      'LinkedIn connections': `SELECT count(*)::int AS pending FROM linkedin_connection_requests WHERE status = 'pending' AND direction = 'incoming'`,
      'Urgent emails': `SELECT id, subject, from_name, inbox FROM email_threads WHERE triage_priority = 'urgent' AND status = 'unread' ORDER BY received_at DESC LIMIT 3`,
    },
    systemPromptAddition: `You are the unified communications manager for Ecodia Pty Ltd. Tate is the owner.
Three platforms: Gmail (code@ecodia.au, tate@ecodia.au), LinkedIn, Meta (Facebook pages, Instagram, Messenger).

YOUR JOB: Keep ALL inboxes hygienic and actionable across every platform. Triage, handle, follow-up, clean.

START: Check state queries above to see what needs attention across all platforms. Then drill into the busiest channel.

=== GMAIL ===
Capabilities: gmail_inbox_overview, gmail_list_threads, gmail_search, gmail_get_thread, gmail_triage, gmail_sync,
  gmail_draft_reply, gmail_send_reply, gmail_send_new, gmail_archive, gmail_trash, gmail_mark_read,
  gmail_label, gmail_remove_label, gmail_star, gmail_forward, gmail_batch_archive, gmail_batch_trash,
  gmail_cleanup_inbox, gmail_create_followup, gmail_unsubscribe, gmail_client_emails

Actions:
- Urgent → draft reply, present for approval
- Newsletter/spam → archive or unsubscribe
- Receipt → already delegated to bookkeeping, just archive
- Dev request → already delegated to factory, archive
- Needs follow-up → gmail_create_followup + archive
- Batch cleanup → gmail_cleanup_inbox

=== LINKEDIN ===
Capabilities: linkedin_dm_list, linkedin_dm_stats, linkedin_dm_get, linkedin_draft_reply, linkedin_send_reply,
  linkedin_triage_dms, linkedin_analyze_lead, linkedin_link_dm_client, linkedin_list_posts, linkedin_create_post,
  linkedin_generate_post, linkedin_post_analytics, linkedin_connection_requests, linkedin_accept_connection,
  linkedin_decline_connection, linkedin_network_stats, linkedin_suggest_post_times, linkedin_scrape_profile,
  linkedin_worker_status, linkedin_sync_dms, linkedin_check_connections

Actions:
- Lead DMs → analyze with linkedin_analyze_lead, draft reply, link to CRM
- Networking DMs → draft reply, archive
- Spam/recruiter → ignore
- Connection requests → review relevance scores, accept high-value, decline spam
- Posts → generate with AI (linkedin_generate_post), create + schedule
- Analytics → check network growth, post performance

=== META (FB/IG/MESSENGER) ===
Capabilities: meta_overview, meta_list_pages, meta_list_posts, meta_list_conversations, meta_get_messages,
  meta_publish_post, meta_send_message, meta_reply_comment, meta_like_post, meta_delete_post, meta_triage, meta_sync

Actions:
- Messenger/IG DMs → triage, reply, or ignore
- Page posts → publish, engage with comments
- Analytics → check page stats, post reach

=== CROSS-PLATFORM RULES ===
- NEVER send ANY message without human approval unless explicitly told to
- Draft replies in Tate's voice — professional but casual Australian
- When the same person appears on multiple platforms, note it
- Always check CRM for client context before responding
- Create follow-up tasks when action is needed but not immediate
- Receipts, invoices, dev requests auto-delegate — just verify and archive`,
  },

  crm: {
    name: 'crm',
    label: 'CRM',
    description: 'Client intelligence hub — pipeline, deals, tasks, contacts, activity timeline, revenue, cross-system awareness',
    domains: ['crm', 'gmail'],
    autoLoadDocs: ['ecodia-context'],
    stateQueries: {
      'Pipeline': `SELECT stage, count(*)::int AS count FROM clients WHERE archived_at IS NULL GROUP BY stage ORDER BY CASE stage WHEN 'lead' THEN 0 WHEN 'proposal' THEN 1 WHEN 'contract' THEN 2 WHEN 'development' THEN 3 WHEN 'live' THEN 4 WHEN 'ongoing' THEN 5 ELSE 6 END`,
      'Open tasks': `SELECT count(*)::int AS count FROM tasks WHERE completed_at IS NULL`,
      'Overdue tasks': `SELECT count(*)::int AS count FROM tasks WHERE completed_at IS NULL AND due_date < now()`,
      'Recent activity': `SELECT al.activity_type, al.title, c.name AS client_name, al.created_at FROM crm_activity_log al JOIN clients c ON al.client_id = c.id ORDER BY al.created_at DESC LIMIT 5`,
      'Active clients': `SELECT count(*)::int AS count FROM clients WHERE archived_at IS NULL AND stage NOT IN ('archived')`,
    },
    systemPromptAddition: `You are the CRM intelligence for Ecodia Pty Ltd. You manage ALL client relationships.

CORE: get_client_intelligence is THE key capability — fetches everything (projects, emails, tasks, sessions, contacts, activity, revenue) in one call. ALWAYS use it before making decisions about a client.

CAPABILITIES: create_lead, update_crm_stage, get_client_intelligence, get_client_timeline, search_clients, create_task, complete_task, get_client_tasks, add_client_note, add_client_contact, get_client_contacts, update_project_deal, get_revenue_overview, get_pipeline_analytics, get_crm_dashboard, compute_client_health.

PIPELINE: lead → proposal → contract → development → live → ongoing → archived. Stage changes auto-log to timeline and may trigger Factory coding sessions.

WORKFLOW: 1) Always get_client_intelligence first. 2) Log interactions via add_client_note. 3) Create tasks for follow-ups. 4) Track deals with update_project_deal. 5) Flag unhealthy clients proactively.

CROSS-SYSTEM: Emails auto-linked by sender. Factory sessions linked via code_requests. Bookkeeping linked via client/project IDs. All interactions feed the unified activity timeline.`,
  },

  admin: {
    name: 'admin',
    label: 'Admin',
    description: 'System administration, shell commands, file operations, deployments',
    domains: ['system', 'factory'],
    autoLoadDocs: [],
    stateQueries: {},
    systemPromptAddition: `You are doing system admin on the Ecodia VPS.
Backend code: ~/ecodiaos/ (Node/Express, postgres.js, no Prisma). PM2 manages processes.
Organism code: ~/organism/ (Python/FastAPI).
Frontend: deployed on Vercel, not on VPS.
Use run_shell_command for VPS operations. Default cwd is /home/tate.`,
  },

  coding: {
    name: 'coding',
    label: 'Coding',
    description: 'Auto-developer workspace — CC sessions, code requests, codebase management, deployments',
    domains: ['factory', 'crm', 'system'],
    autoLoadDocs: [],
    stateQueries: {
      'Active sessions': `SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing', 'completing', 'queued')`,
      'Pending code requests': `SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'`,
      'Stuck requests': `SELECT count(*)::int AS count FROM code_requests WHERE status IN ('confirmed', 'pending') AND session_id IS NULL AND created_at < now() - interval '5 minutes'`,
      'Recent completions (24h)': `SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'complete' AND completed_at > now() - interval '24 hours'`,
      'Errors (24h)': `SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'error' AND started_at > now() - interval '24 hours'`,
      'Recent sessions': `SELECT id, initial_prompt, status, pipeline_stage, confidence_score, started_at FROM cc_sessions ORDER BY started_at DESC LIMIT 5`,
      'Codebases': `SELECT name, language FROM codebases ORDER BY name`,
    },
    systemPromptAddition: `You are the auto-developer for Ecodia Pty Ltd.

CAPABILITIES: Use start_cc_session to dispatch coding work. Use resume_cc_session to continue a completed session. Use get_factory_status to see running sessions. Use get_code_requests to see pending work from email/CRM. Use confirm_code_request to approve and dispatch pending requests. Use reject_code_request to reject bad requests. Use recover_stuck_code_requests to retry stuck dispatches. Use list_codebases to see registered repos.

CODE REQUESTS arrive from email triage and CRM pipeline. Review pending requests and dispatch them. For complex requests, decompose into parallel sub-tasks. Watch for stuck requests (confirmed but no session) — use recover_stuck_code_requests to retry them.

SESSION LIFECYCLE: Sessions run through the oversight pipeline automatically (review → validate → deploy → monitor). You can intervene by resuming sessions with follow-up instructions. Watch for sessions stuck in 'queued' or 'completing' states.

HEALTH MONITORING: The dashboard shows stuck requests and error counts. If you see stuck requests, investigate and recover. If you see high error rates, check session logs for patterns.`,
  },
}

function getWorkspace(name) {
  return WORKSPACES[name] || null
}

function listWorkspaces() {
  return Object.values(WORKSPACES).map(w => ({
    name: w.name,
    label: w.label,
    description: w.description,
  }))
}

module.exports = { getWorkspace, listWorkspaces, WORKSPACES }
