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
    domains: ['bookkeeping'],
    autoLoadDocs: ['chart-of-accounts', 'supplier-rules', 'gst-rules'],
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

QUESTIONS: Use question blocks to ask the human when unsure about categorization. Don't guess on ambiguous items — ask.`,
  },

  email: {
    name: 'email',
    label: 'Email',
    description: 'Gmail inbox management, triage, replies, drafts',
    domains: ['gmail'],
    autoLoadDocs: [],
    stateQueries: {
      'Unread threads': `SELECT count(*)::int AS count FROM email_threads WHERE is_read = false`,
      'Urgent emails': `SELECT subject, sender_name, received_at FROM email_threads WHERE triage_priority = 'urgent' AND is_read = false ORDER BY received_at DESC LIMIT 5`,
    },
    systemPromptAddition: `You are managing email for Ecodia Pty Ltd. Tate is the owner.
Triage emails by urgency. Draft replies in a professional but casual Australian tone.
Never send an email without explicit approval unless the user says to.`,
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
