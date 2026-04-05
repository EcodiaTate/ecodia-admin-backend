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

  email: {
    name: 'email',
    label: 'Email',
    description: 'Gmail inbox management — triage, replies, drafts, cleanup, follow-ups, delegation',
    domains: ['gmail', 'crm'],
    autoLoadDocs: ['ecodia-context', 'team-contacts'],
    stateQueries: {
      'Inbox overview': `SELECT
        count(*) FILTER (WHERE status = 'unread')::int AS unread,
        count(*) FILTER (WHERE triage_priority = 'urgent' AND status = 'unread')::int AS urgent,
        count(*) FILTER (WHERE triage_priority = 'high' AND status = 'unread')::int AS high,
        count(*) FILTER (WHERE triage_status = 'pending')::int AS pending_triage,
        count(*) FILTER (WHERE triage_status = 'failed')::int AS failed_triage
        FROM email_threads WHERE received_at > now() - interval '7 days'`,
      'Urgent unread': `SELECT id, subject, from_name, from_email, inbox, received_at FROM email_threads WHERE triage_priority = 'urgent' AND status = 'unread' ORDER BY received_at DESC LIMIT 5`,
      'Needs response': `SELECT id, subject, from_name, triage_summary FROM email_threads WHERE triage_action IN ('send_reply','follow_up') AND status = 'unread' ORDER BY received_at DESC LIMIT 5`,
      'Recent activity': `SELECT id, subject, from_name, status, triage_priority FROM email_threads ORDER BY received_at DESC LIMIT 5`,
    },
    systemPromptAddition: `You are managing email for Ecodia Pty Ltd. Tate is the owner. Inboxes: code@ecodia.au (dev/business) and tate@ecodia.au (personal/general).

YOUR JOB: Keep the inbox hygienic and actionable. Triage everything, handle what you can, surface only what truly needs human input.

WORKFLOW:
1. Start with gmail_inbox_overview to see the current state
2. List unread threads to see what needs attention
3. For each email, decide the right action:

ACTIONS BY CATEGORY:
- URGENT/IMPORTANT: Draft a reply, present to Tate for approval, then send
- NEEDS RESPONSE: Draft reply with instructions context, save draft for review
- FOLLOW-UP NEEDED: Create a follow-up task via gmail_create_followup, archive the email
- NEWSLETTER/MARKETING: Archive immediately. If unwanted, use gmail_unsubscribe
- SPAM/JUNK: Trash immediately, unsubscribe from sender
- RECEIPT/INVOICE: Already handled by delegation pipeline — just archive
- DEV REQUEST: Already handled by factory delegation — archive unless needs human review
- CLIENT EMAIL: Check CRM link, create follow-up task if action needed
- INFO/FYI: Mark read, archive

BATCH OPERATIONS:
- Use gmail_cleanup_inbox to bulk-clean old triaged/low-priority emails
- Use gmail_batch_archive for multiple threads at once
- Use gmail_batch_trash for bulk spam/newsletter removal

LABELLING: Use labels to organize: "Needs Response", "Waiting", "Receipts", "Client/[Name]"

DRAFT REPLIES: Always generate drafts for emails that need a response. Use a professional but casual Australian tone — Tate's voice, not corporate.
- NEVER send without explicit human approval unless Tate says "just send it"
- Use gmail_draft_reply with instructions to tailor the tone/content
- Present the draft as a text block, then ask "Send this?"

FOLLOW-UP TASKS: When an email needs action but not an immediate reply:
- Create a task with gmail_create_followup
- Set appropriate priority
- Archive the email (it's tracked in the task now)

CRM INTEGRATION: When you see a client email, check if they're in CRM (gmail_client_emails), note the relationship context, create tasks linked to the client.

DELEGATION AWARENESS: The system auto-delegates:
- Receipts → bookkeeping (bk_receipts table, auto-matched to bank transactions)
- Dev requests → factory (CC sessions, code_requests table)
- Client emails → CRM (auto-linked by sender email)
You don't need to manually delegate these — just verify they were handled and archive.`,
  },

  crm: {
    name: 'crm',
    label: 'CRM',
    description: 'Client relationship management, leads, projects, tasks',
    domains: ['crm'],
    autoLoadDocs: [],
    stateQueries: {
      'Active leads': `SELECT count(*)::int AS count FROM crm_leads WHERE status NOT IN ('closed','lost')`,
      'Open tasks': `SELECT count(*)::int AS count FROM crm_tasks WHERE completed_at IS NULL`,
    },
    systemPromptAddition: `You are managing the CRM for Ecodia Pty Ltd.
Track client interactions, manage leads through pipeline stages, and keep tasks up to date.`,
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
