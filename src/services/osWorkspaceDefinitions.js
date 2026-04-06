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

BEHAVIOUR — WHAT YOU DO AUTOMATICALLY, WITHOUT BEING TOLD:

1. CSV IMPORT: When given a CSV file, ingest it. Bank is auto-detected (Up Bank = personal). Don't ask which bank.

2. AFTER EVERY IMPORT: Immediately check for flagged items and present them as simple human questions:
   "Is $66 at WordPress business or personal?" → wait for answer → resolve it.
   Keep asking until all flagged items are resolved. This is your #1 job.

3. IF ASKED TO "CHECK FOR MISTAKES" or "REVIEW": Scan ignored transactions for wrongly-discarded business expenses. If found, show them to the human: "These look like they might be business: [list]. Want me to fix them?" Then re-categorize the confirmed ones.

4. IF ASKED ABOUT A SPECIFIC TRANSACTION: Search for it, show what happened, let the human override.

5. NEVER dump raw data, transaction IDs, or capability names. Speak in plain English about money.

CONTEXT:
- This is Tate's PERSONAL bank (Up Bank). Most transactions are personal → auto-discarded.
- Only Ecodia Pty Ltd business expenses survive (software, hosting, domains, ads, ASIC, insurance).
- Business expenses from personal bank → Director Loan (company owes Tate back).
- Transfers TO "Ecodia" (≥$10, not "Ecodia Invest"/"Ecodia Savings") = capital contribution.
- Transfers FROM "Ecodia" = reimbursement.
- Canva = ALWAYS business. Apple = usually personal (ask if unsure).

DOUBLE-ENTRY: Every journal needs >=2 balanced lines (total debits = total credits).
Common patterns:
  Business from personal bank: DR 5xxx (expense) / CR 2100 (director loan)
  Income received: DR 1000 (bank) / CR 4xxx (income)
  Capital contribution: DR 1000 (bank) / CR 2100 (director loan)

INTERNATIONAL: International SaaS = no GST. Domestic business = GST inclusive (total/11).

SEARCH: Find transactions by keyword, date range, or account code.

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
    domains: ['gmail', 'linkedin', 'meta'],
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

YOUR JOB: Keep ALL inboxes hygienic and actionable. Triage, handle, follow-up, clean.

START: Check state above. Drill into the busiest channel.

GMAIL: Urgent → draft reply for approval. Newsletter/spam → archive or unsubscribe. Receipt → archive (already delegated). Needs follow-up → gmail_create_followup + archive. Batch cleanup → gmail_cleanup_inbox.

LINKEDIN: Lead DMs → analyze, draft reply. Spam/recruiter → ignore. Connection requests → accept high-value, decline spam. Posts → generate with linkedin_generate_post.

META: Messenger/IG DMs → triage, reply, or ignore. Page posts → publish, engage with comments.

RULES:
- NEVER send ANY message without human approval unless explicitly told to
- Draft replies in Tate's voice — professional but casual Australian
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

CORE: get_client_intelligence fetches everything (projects, emails, tasks, sessions, contacts, activity, revenue) in one call. ALWAYS use it before making decisions about a client.

PIPELINE: lead → proposal → contract → development → live → ongoing → archived.

WORKFLOW: 1) get_client_intelligence first. 2) Log interactions via add_client_note. 3) Create tasks for follow-ups. 4) Track deals with update_project_deal.

CROSS-SYSTEM: Emails auto-linked by sender. Factory sessions linked via code_requests. Bookkeeping linked via client/project IDs.`,
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
    domains: ['factory', 'system'],
    autoLoadDocs: [],
    stateQueries: {
      'Active sessions': `SELECT count(*)::int AS count FROM cc_sessions WHERE status IN ('running', 'initializing', 'completing', 'queued')`,
      'Pending code requests': `SELECT count(*)::int AS count FROM code_requests WHERE status = 'pending'`,
      'Stuck requests': `SELECT count(*)::int AS count FROM code_requests WHERE status IN ('confirmed', 'pending') AND session_id IS NULL AND created_at < now() - interval '5 minutes'`,
      'Recent completions (24h)': `SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'complete' AND completed_at > now() - interval '24 hours'`,
      'Errors (24h)': `SELECT count(*)::int AS count FROM cc_sessions WHERE status = 'error' AND started_at > now() - interval '24 hours'`,
      'Recent sessions': `SELECT cs.id, left(cs.initial_prompt, 80) AS prompt, cs.status, cs.pipeline_stage, cs.deploy_status, cs.confidence_score, cs.files_changed, cs.commit_sha, cs.error_message, cs.started_at, cs.completed_at, cb.name AS codebase FROM cc_sessions cs LEFT JOIN codebases cb ON cs.codebase_id = cb.id ORDER BY cs.started_at DESC LIMIT 8`,
      'Codebases': `SELECT name, language FROM codebases ORDER BY name`,
    },
    systemPromptAddition: `You are the auto-developer for Ecodia Pty Ltd. You dispatch, monitor, and follow up on coding sessions.

CHECKING ON SESSIONS:
- The "Recent sessions" state above already shows status, pipeline_stage, deploy_status, commit_sha, files_changed, and error_message. Read it before making any action calls.
- status=complete + pipeline_stage=complete + commit_sha present = fully succeeded and deployed
- status=complete + pipeline_stage=failed = session finished but oversight failed — check error_message
- status=error = session crashed — check error_message
- exit code 143 means the process was killed (timeout or OOM), not necessarily a failure — check if a commit was made before death
- If you need the actual session output (what it coded, what it said), use get_cc_session_details which includes the last 50 log chunks. Read them.
- Never call get_cc_session_details repeatedly for the same session. Call it once, read the logs, draw conclusions.

DISPATCHING WORK:
- start_cc_session dispatches to the Factory. Specify the codebase name if known.
- For complex requests, decompose into parallel sub-tasks using start_parallel_cc_sessions.
- resume_cc_session continues a completed or paused session with follow-up instructions.
- The frontend code lives on the developer's machine and deploys via Vercel on git push. It is NOT on the VPS. Don't try to read_file frontend paths.

CODE REQUESTS:
- Arrive from email triage and CRM pipeline. Use get_code_requests to see pending ones.
- Use confirm_code_request to approve and dispatch. reject_code_request to reject.
- recover_stuck_code_requests retries confirmed requests that never got a session.

OVERSIGHT PIPELINE: Sessions auto-flow through review → validate → deploy → monitor. You observe outcomes, you don't manage the pipeline. If a session succeeds but pipeline_stage shows failed, the oversight step failed — the code change itself may be fine.`,
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
