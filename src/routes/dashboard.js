const { Router } = require('express')
const db = require('../config/db')

const router = Router()

// GET /api/dashboard/data — live JSON snapshot
router.get('/data', async (_req, res, next) => {
  try {
    const results = {}

    await Promise.allSettled([
      // Revenue from ledger (income accounts = 4xxx, credit - debit = net income)
      db`
        SELECT
          COALESCE(SUM(CASE WHEN t.occurred_at >= now() - interval '30 days' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0)::bigint AS revenue_30d_cents,
          COALESCE(SUM(CASE WHEN t.occurred_at >= now() - interval '90 days' THEN l.credit_cents - l.debit_cents ELSE 0 END), 0)::bigint AS revenue_90d_cents
        FROM ledger_lines l
        JOIN ledger_transactions t ON t.id = l.tx_id
        WHERE l.account_code LIKE '4%'
          AND t.occurred_at >= now() - interval '90 days'
      `.then(([r]) => {
        results.cash = {
          revenue_30d_aud: r ? Math.round(r.revenue_30d_cents / 100) : 0,
          revenue_90d_aud: r ? Math.round(r.revenue_90d_cents / 100) : 0,
        }
      }).catch(() => { results.cash = { revenue_30d_aud: null, revenue_90d_aud: null } }),

      // Pipeline from status_board
      db`
        SELECT name, status, next_action, next_action_by, next_action_due, priority, entity_type, last_touched
        FROM status_board
        WHERE archived_at IS NULL
        ORDER BY priority ASC, last_touched DESC NULLS LAST
        LIMIT 100
      `.then(rows => { results.pipeline = { items: rows } })
        .catch(() => { results.pipeline = { items: [] } }),

      // Overdue
      db`
        SELECT name, next_action, next_action_due, priority, entity_type
        FROM status_board
        WHERE next_action_due < now() AND archived_at IS NULL
        ORDER BY next_action_due ASC
        LIMIT 50
      `.then(rows => { results.overdue = { items: rows } })
        .catch(() => { results.overdue = { items: [] } }),

      // Tate-blocking
      db`
        SELECT name, next_action, priority, entity_type
        FROM status_board
        WHERE next_action_by = 'tate' AND archived_at IS NULL
        ORDER BY priority ASC
        LIMIT 50
      `.then(rows => { results.tate_blocking = { count: rows.length, items: rows } })
        .catch(() => { results.tate_blocking = { count: 0, items: [] } }),

      // Factory sessions last 24h
      db`
        SELECT cs.id, cs.status, cs.pipeline_stage, cs.started_at, cs.confidence_score, cs.files_changed,
               cb.name AS codebase
        FROM cc_sessions cs
        LEFT JOIN codebases cb ON cb.id = cs.codebase_id
        WHERE cs.started_at > now() - interval '24 hours'
        ORDER BY cs.started_at DESC
        LIMIT 20
      `.then(rows => {
        const active = rows.filter(r => ['running', 'initializing', 'queued'].includes(r.status)).length
        results.factory = { active_count: active, recent_24h: rows }
      }).catch(() => { results.factory = { active_count: 0, recent_24h: [] } }),

      // Clients by status
      db`
        SELECT status, count(*)::int AS count
        FROM clients
        WHERE archived_at IS NULL
        GROUP BY status
        ORDER BY count DESC
      `.then(rows => {
        const by_status = {}
        let total = 0
        for (const r of rows) { by_status[r.status] = r.count; total += r.count }
        results.clients_active = { count: total, by_status }
      }).catch(() => { results.clients_active = { count: 0, by_status: {} } }),
    ])

    res.json({ generated_at: new Date().toISOString(), ...results })
  } catch (err) { next(err) }
})

// GET /api/dashboard — self-contained HTML dashboard
router.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(buildHtml())
})

function buildHtml() {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>EcodiaOS Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>tailwind.config = { darkMode: 'class' }</script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .badge-ecodiaos { background: #1e3a2f; color: #4ade80; }
    .badge-tate { background: #3b1f1f; color: #f87171; }
    .badge-client { background: #1e2a3b; color: #60a5fa; }
    .badge-external { background: #2d2a1e; color: #fbbf24; }
    .status-running { color: #4ade80; }
    .status-complete { color: #a3a3a3; }
    .status-error { color: #f87171; }
    .status-awaiting { color: #fbbf24; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spin { animation: spin 1s linear infinite; }
  </style>
</head>
<body class="bg-gray-950 text-gray-100 min-h-screen p-4 md:p-6">

  <div class="max-w-7xl mx-auto">

    <!-- Header -->
    <div class="flex items-center justify-between mb-6">
      <div>
        <h1 class="text-xl font-semibold text-white">EcodiaOS</h1>
        <p class="text-xs text-gray-500 mt-0.5" id="generated-at">Loading...</p>
      </div>
      <div class="flex items-center gap-3">
        <span id="auto-refresh-badge" class="text-xs text-gray-600">auto-refresh in <span id="countdown">60</span>s</span>
        <button onclick="loadData()" class="text-xs bg-gray-800 hover:bg-gray-700 text-gray-300 px-3 py-1.5 rounded border border-gray-700 transition-colors">
          Refresh
        </button>
      </div>
    </div>

    <!-- Loading / error state -->
    <div id="loading" class="text-center py-16 text-gray-500">
      <div class="inline-block w-6 h-6 border-2 border-gray-600 border-t-green-500 rounded-full spin mb-3"></div>
      <p class="text-sm">Loading dashboard...</p>
    </div>
    <div id="error-banner" class="hidden mb-4 p-3 bg-red-950 border border-red-800 rounded text-red-400 text-sm"></div>

    <div id="content" class="hidden">

      <!-- Stat cards -->
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p class="text-xs text-gray-500 mb-1">Revenue 30d</p>
          <p class="text-2xl font-semibold text-green-400" id="stat-rev-30d">-</p>
        </div>
        <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p class="text-xs text-gray-500 mb-1">Revenue 90d</p>
          <p class="text-2xl font-semibold text-green-400" id="stat-rev-90d">-</p>
        </div>
        <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p class="text-xs text-gray-500 mb-1">Tate Blocking</p>
          <p class="text-2xl font-semibold text-amber-400" id="stat-tate">-</p>
        </div>
        <div class="bg-gray-900 rounded-lg p-4 border border-gray-800">
          <p class="text-xs text-gray-500 mb-1">Overdue</p>
          <p class="text-2xl font-semibold text-red-400" id="stat-overdue">-</p>
        </div>
      </div>

      <!-- Main columns -->
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">

        <!-- Pipeline -->
        <div class="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden">
          <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
            <h2 class="text-sm font-medium text-gray-200">Pipeline</h2>
            <span class="text-xs text-gray-600" id="pipeline-count"></span>
          </div>
          <div id="pipeline-list" class="divide-y divide-gray-800 max-h-96 overflow-y-auto"></div>
        </div>

        <!-- Right column -->
        <div class="flex flex-col gap-4">

          <!-- Overdue -->
          <div class="bg-gray-900 rounded-lg border border-red-900/40 overflow-hidden">
            <div class="px-4 py-3 border-b border-red-900/40">
              <h2 class="text-sm font-medium text-red-400">Overdue</h2>
            </div>
            <div id="overdue-list" class="divide-y divide-gray-800 max-h-48 overflow-y-auto"></div>
            <div id="overdue-empty" class="hidden px-4 py-3 text-xs text-gray-600">Nothing overdue</div>
          </div>

          <!-- Tate blocking -->
          <div class="bg-gray-900 rounded-lg border border-amber-900/40 overflow-hidden">
            <div class="px-4 py-3 border-b border-amber-900/40">
              <h2 class="text-sm font-medium text-amber-400">Waiting on Tate</h2>
            </div>
            <div id="tate-list" class="divide-y divide-gray-800 max-h-48 overflow-y-auto"></div>
            <div id="tate-empty" class="hidden px-4 py-3 text-xs text-gray-600">Nothing blocking</div>
          </div>

        </div>
      </div>

      <!-- Factory sessions -->
      <div class="bg-gray-900 rounded-lg border border-gray-800 overflow-hidden mb-4">
        <div class="px-4 py-3 border-b border-gray-800 flex items-center justify-between">
          <h2 class="text-sm font-medium text-gray-200">Factory (24h)</h2>
          <span class="text-xs" id="factory-active-badge"></span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-gray-800">
                <th class="text-left px-4 py-2 text-gray-500 font-normal">Codebase</th>
                <th class="text-left px-4 py-2 text-gray-500 font-normal">Status</th>
                <th class="text-left px-4 py-2 text-gray-500 font-normal">Stage</th>
                <th class="text-left px-4 py-2 text-gray-500 font-normal hidden md:table-cell">Confidence</th>
                <th class="text-left px-4 py-2 text-gray-500 font-normal hidden md:table-cell">Started</th>
              </tr>
            </thead>
            <tbody id="factory-table"></tbody>
          </table>
          <div id="factory-empty" class="hidden px-4 py-3 text-xs text-gray-600">No sessions in the last 24h</div>
        </div>
      </div>

      <!-- Clients -->
      <div class="bg-gray-900 rounded-lg border border-gray-800 p-4">
        <p class="text-xs text-gray-500 mb-2">Clients by stage</p>
        <div id="clients-by-status" class="flex flex-wrap gap-2"></div>
      </div>

    </div>
  </div>

<script>
let countdownTimer = null
let countdown = 60

function fmt(n) {
  if (n === null || n === undefined) return 'n/a'
  return '$' + n.toLocaleString('en-AU')
}

function timeAgo(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const s = Math.floor(diff / 1000)
  if (s < 60) return s + 's ago'
  const m = Math.floor(s / 60)
  if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60)
  if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

function priorityDot(p) {
  if (p === 1) return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-red-500 mr-1.5"></span>'
  if (p === 2) return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-amber-500 mr-1.5"></span>'
  if (p === 3) return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 mr-1.5"></span>'
  return '<span class="inline-block w-1.5 h-1.5 rounded-full bg-gray-600 mr-1.5"></span>'
}

function ownerBadge(by) {
  const cls = {
    ecodiaos: 'badge-ecodiaos',
    tate: 'badge-tate',
    client: 'badge-client',
    external: 'badge-external',
  }[by] || 'bg-gray-800 text-gray-400'
  return '<span class="text-xs px-1.5 py-0.5 rounded ' + cls + '">' + (by || '-') + '</span>'
}

function sessionStatusClass(status) {
  if (['running', 'initializing', 'queued'].includes(status)) return 'status-running'
  if (status === 'complete') return 'status-complete'
  if (status === 'error') return 'status-error'
  if (status === 'awaiting_review') return 'status-awaiting'
  return 'text-gray-400'
}

async function loadData() {
  try {
    const res = await fetch('/api/dashboard/data')
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const d = await res.json()

    document.getElementById('loading').classList.add('hidden')
    document.getElementById('error-banner').classList.add('hidden')
    document.getElementById('content').classList.remove('hidden')

    // Generated at
    document.getElementById('generated-at').textContent = 'As of ' + new Date(d.generated_at).toLocaleString('en-AU')

    // Stats
    const cash = d.cash || {}
    document.getElementById('stat-rev-30d').textContent = cash.revenue_30d_aud !== null ? fmt(cash.revenue_30d_aud) : 'n/a'
    document.getElementById('stat-rev-90d').textContent = cash.revenue_90d_aud !== null ? fmt(cash.revenue_90d_aud) : 'n/a'
    document.getElementById('stat-tate').textContent = (d.tate_blocking || {}).count ?? '-'
    document.getElementById('stat-overdue').textContent = ((d.overdue || {}).items || []).length || '0'

    // Pipeline
    const pipeline = (d.pipeline || {}).items || []
    document.getElementById('pipeline-count').textContent = pipeline.length + ' items'
    const pl = document.getElementById('pipeline-list')
    if (pipeline.length === 0) {
      pl.innerHTML = '<div class="px-4 py-3 text-xs text-gray-600">Empty</div>'
    } else {
      pl.innerHTML = pipeline.map(item => {
        return '<div class="px-4 py-2.5 flex items-start justify-between gap-2 hover:bg-gray-800/50">'
          + '<div class="min-w-0 flex-1">'
          + '<div class="flex items-center gap-1">'
          + priorityDot(item.priority)
          + '<span class="text-sm text-gray-200 truncate">' + esc(item.name) + '</span>'
          + '<span class="text-xs text-gray-600 shrink-0">' + esc(item.entity_type || '') + '</span>'
          + '</div>'
          + (item.next_action ? '<p class="text-xs text-gray-500 mt-0.5 truncate">' + esc(item.next_action) + '</p>' : '')
          + '</div>'
          + '<div class="shrink-0 flex items-center gap-1.5">'
          + ownerBadge(item.next_action_by)
          + '<span class="text-xs text-gray-700">' + timeAgo(item.last_touched) + '</span>'
          + '</div>'
          + '</div>'
      }).join('')
    }

    // Overdue
    const overdue = (d.overdue || {}).items || []
    const overdueEl = document.getElementById('overdue-list')
    if (overdue.length === 0) {
      overdueEl.innerHTML = ''
      document.getElementById('overdue-empty').classList.remove('hidden')
    } else {
      document.getElementById('overdue-empty').classList.add('hidden')
      overdueEl.innerHTML = overdue.map(item => {
        const due = item.next_action_due ? new Date(item.next_action_due).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) : ''
        return '<div class="px-4 py-2 hover:bg-gray-800/50">'
          + '<div class="flex items-center justify-between">'
          + '<span class="text-sm text-red-300">' + esc(item.name) + '</span>'
          + (due ? '<span class="text-xs text-red-600">' + due + '</span>' : '')
          + '</div>'
          + (item.next_action ? '<p class="text-xs text-gray-500 mt-0.5 truncate">' + esc(item.next_action) + '</p>' : '')
          + '</div>'
      }).join('')
    }

    // Tate blocking
    const tate = (d.tate_blocking || {}).items || []
    const tateEl = document.getElementById('tate-list')
    if (tate.length === 0) {
      tateEl.innerHTML = ''
      document.getElementById('tate-empty').classList.remove('hidden')
    } else {
      document.getElementById('tate-empty').classList.add('hidden')
      tateEl.innerHTML = tate.map(item => {
        return '<div class="px-4 py-2 hover:bg-gray-800/50">'
          + '<span class="text-sm text-amber-300">' + esc(item.name) + '</span>'
          + (item.next_action ? '<p class="text-xs text-gray-500 mt-0.5 truncate">' + esc(item.next_action) + '</p>' : '')
          + '</div>'
      }).join('')
    }

    // Factory
    const sessions = (d.factory || {}).recent_24h || []
    const activeCount = (d.factory || {}).active_count || 0
    const activeBadge = document.getElementById('factory-active-badge')
    activeBadge.textContent = activeCount > 0 ? activeCount + ' running' : ''
    activeBadge.className = 'text-xs ' + (activeCount > 0 ? 'text-green-400' : 'text-gray-600')
    const tbody = document.getElementById('factory-table')
    const factoryEmpty = document.getElementById('factory-empty')
    if (sessions.length === 0) {
      tbody.innerHTML = ''
      factoryEmpty.classList.remove('hidden')
    } else {
      factoryEmpty.classList.add('hidden')
      tbody.innerHTML = sessions.map(s => {
        const conf = s.confidence_score != null ? Math.round(s.confidence_score * 100) + '%' : '-'
        const stCls = sessionStatusClass(s.status)
        return '<tr class="border-b border-gray-800 hover:bg-gray-800/30">'
          + '<td class="px-4 py-2 text-gray-300">' + esc(s.codebase || '-') + '</td>'
          + '<td class="px-4 py-2"><span class="' + stCls + '">' + esc(s.status || '-') + '</span></td>'
          + '<td class="px-4 py-2 text-gray-500">' + esc(s.pipeline_stage || '-') + '</td>'
          + '<td class="px-4 py-2 text-gray-500 hidden md:table-cell">' + conf + '</td>'
          + '<td class="px-4 py-2 text-gray-600 hidden md:table-cell">' + timeAgo(s.started_at) + '</td>'
          + '</tr>'
      }).join('')
    }

    // Clients
    const byStatus = (d.clients_active || {}).by_status || {}
    const statusOrder = ['lead', 'proposal', 'contract', 'development', 'live', 'ongoing', 'archived']
    const statusColors = {
      lead: 'bg-gray-800 text-gray-300',
      proposal: 'bg-blue-900/50 text-blue-300',
      contract: 'bg-purple-900/50 text-purple-300',
      development: 'bg-yellow-900/50 text-yellow-300',
      live: 'bg-green-900/50 text-green-300',
      ongoing: 'bg-emerald-900/50 text-emerald-300',
      archived: 'bg-gray-900 text-gray-600',
    }
    const clientsEl = document.getElementById('clients-by-status')
    const entries = statusOrder.filter(s => byStatus[s]).map(s => {
      const cls = statusColors[s] || 'bg-gray-800 text-gray-400'
      return '<span class="text-xs px-2 py-1 rounded ' + cls + '">' + s + ' ' + byStatus[s] + '</span>'
    })
    clientsEl.innerHTML = entries.length ? entries.join('') : '<span class="text-xs text-gray-600">No data</span>'

  } catch (err) {
    document.getElementById('loading').classList.add('hidden')
    const banner = document.getElementById('error-banner')
    banner.textContent = 'Failed to load: ' + err.message
    banner.classList.remove('hidden')
  }

  // Reset countdown
  countdown = 60
}

function esc(str) {
  if (!str) return ''
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function startCountdown() {
  if (countdownTimer) clearInterval(countdownTimer)
  countdown = 60
  countdownTimer = setInterval(() => {
    countdown--
    const el = document.getElementById('countdown')
    if (el) el.textContent = countdown
    if (countdown <= 0) {
      loadData()
      countdown = 60
    }
  }, 1000)
}

loadData()
startCountdown()
</script>
</body>
</html>`
}

module.exports = router
