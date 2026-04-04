const { Router } = require('express')
const auth = require('../middleware/auth')
const { runQuery, healthCheck } = require('../config/neo4j')
const logger = require('../config/logger')

const router = Router()

// GET /kg-explorer — serve the explorer UI (no auth, page handles its own auth)
router.get('/', (_req, res) => {
  res.send(EXPLORER_HTML)
})

// API endpoints require auth
router.use(auth)

// GET /kg-explorer/status — connection health
router.get('/status', async (_req, res) => {
  try {
    const connected = await healthCheck()
    res.json({ connected })
  } catch {
    res.json({ connected: false })
  }
})

// POST /kg-explorer/query — execute a Cypher query
router.post('/query', async (req, res, next) => {
  try {
    const { cypher, params } = req.body
    if (!cypher || typeof cypher !== 'string') {
      return res.status(400).json({ error: 'cypher query string required' })
    }

    // Read-only guard: block obvious write operations
    const upper = cypher.toUpperCase().trim()
    if (/^(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|DROP|CALL\s+\{)/.test(upper)) {
      return res.status(403).json({ error: 'Write operations not allowed in explorer. Use read-only queries (MATCH, RETURN, etc.).' })
    }

    const start = Date.now()
    const records = await runQuery(cypher, params || {})
    const durationMs = Date.now() - start

    // Convert records to plain objects
    const keys = records.length > 0 ? records[0].keys : []
    const rows = records.map(record => {
      const row = {}
      for (const key of keys) {
        row[key] = serialize(record.get(key))
      }
      return row
    })

    res.json({ keys, rows, count: rows.length, durationMs })
  } catch (err) {
    logger.warn('KG Explorer query failed', { error: err.message })
    res.status(400).json({ error: err.message })
  }
})

// Serialize Neo4j values to plain JSON
function serialize(val) {
  if (val === null || val === undefined) return null
  // Neo4j Integer
  if (val.toInt) return val.toInt()
  if (val.toNumber) return val.toNumber()
  // Node
  if (val.labels && val.properties) {
    return { _type: 'node', labels: val.labels, ...serializeProps(val.properties) }
  }
  // Relationship
  if (val.type && val.properties && val.start) {
    return { _type: 'relationship', type: val.type, ...serializeProps(val.properties) }
  }
  // Path
  if (val.segments) {
    return { _type: 'path', length: val.segments.length }
  }
  // Array
  if (Array.isArray(val)) return val.map(serialize)
  // Plain object
  if (typeof val === 'object') return serializeProps(val)
  return val
}

function serializeProps(props) {
  const out = {}
  for (const [k, v] of Object.entries(props)) {
    if (k === 'embedding') continue // skip large vectors
    out[k] = serialize(v)
  }
  return out
}

const EXPLORER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KG Explorer — EcodiaOS</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'SF Mono', 'Fira Code', monospace; background: #0a0a0f; color: #c8c8d0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
  h1 { font-size: 18px; font-weight: 600; color: #e0e0e8; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
  .status { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .status.connected { background: #4ade80; box-shadow: 0 0 8px #4ade8066; }
  .status.disconnected { background: #f87171; box-shadow: 0 0 8px #f8717166; }
  .status.checking { background: #facc15; }

  .query-area { margin-bottom: 16px; }
  textarea {
    width: 100%; min-height: 120px; padding: 12px; border: 1px solid #2a2a35;
    background: #12121a; color: #e0e0e8; font-family: inherit; font-size: 13px;
    border-radius: 6px; resize: vertical; outline: none;
  }
  textarea:focus { border-color: #6366f1; }

  .controls { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
  button {
    padding: 8px 16px; border: none; border-radius: 4px; cursor: pointer;
    font-family: inherit; font-size: 13px; font-weight: 500;
  }
  .btn-run { background: #6366f1; color: white; }
  .btn-run:hover { background: #5558e6; }
  .btn-run:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn-clear { background: #2a2a35; color: #c8c8d0; }
  .btn-clear:hover { background: #35354a; }
  .meta { color: #666; font-size: 12px; margin-left: auto; }

  .error { background: #1a0a0a; border: 1px solid #7f1d1d; color: #fca5a5; padding: 10px 14px; border-radius: 6px; margin-bottom: 16px; font-size: 13px; white-space: pre-wrap; }

  .results-wrap { overflow-x: auto; margin-bottom: 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { background: #1a1a25; color: #a0a0b0; text-align: left; padding: 8px 12px; border-bottom: 2px solid #2a2a35; position: sticky; top: 0; }
  td { padding: 8px 12px; border-bottom: 1px solid #1a1a25; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td:hover { white-space: normal; word-break: break-all; }
  tr:hover td { background: #14141f; }
  .cell-node { color: #93c5fd; }
  .cell-rel { color: #c4b5fd; }
  .cell-null { color: #555; font-style: italic; }
  .cell-num { color: #fcd34d; }

  .history { margin-top: 24px; }
  .history h2 { font-size: 14px; color: #888; margin-bottom: 8px; }
  .history-item {
    padding: 6px 10px; font-size: 12px; cursor: pointer; border-radius: 4px;
    color: #888; border: 1px solid transparent; margin-bottom: 4px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .history-item:hover { background: #14141f; border-color: #2a2a35; color: #c8c8d0; }

  .auth-overlay {
    position: fixed; inset: 0; background: #0a0a0fee; display: flex;
    align-items: center; justify-content: center; z-index: 100;
  }
  .auth-box { background: #12121a; border: 1px solid #2a2a35; padding: 32px; border-radius: 8px; width: 360px; }
  .auth-box h2 { font-size: 16px; margin-bottom: 16px; color: #e0e0e8; }
  .auth-box input {
    width: 100%; padding: 10px 12px; margin-bottom: 12px; border: 1px solid #2a2a35;
    background: #0a0a0f; color: #e0e0e8; font-family: inherit; font-size: 13px;
    border-radius: 4px; outline: none;
  }
  .auth-box input:focus { border-color: #6366f1; }
  .auth-box .btn-run { width: 100%; }
  .auth-error { color: #fca5a5; font-size: 12px; margin-bottom: 8px; }

  .examples { margin-bottom: 16px; display: flex; gap: 6px; flex-wrap: wrap; }
  .example-chip {
    padding: 4px 10px; background: #1a1a25; border: 1px solid #2a2a35;
    border-radius: 12px; font-size: 11px; color: #888; cursor: pointer;
  }
  .example-chip:hover { border-color: #6366f1; color: #c8c8d0; }
</style>
</head>
<body>
<div class="container">
  <h1>
    <span class="status checking" id="status"></span>
    KG Explorer
  </h1>

  <div class="examples" id="examples">
    <span class="example-chip" data-q="MATCH (n) RETURN labels(n) AS type, count(n) AS count ORDER BY count DESC">Node counts by type</span>
    <span class="example-chip" data-q="MATCH ()-[r]-() RETURN type(r) AS type, count(r) AS count ORDER BY count DESC">Relationship types</span>
    <span class="example-chip" data-q="MATCH (n) RETURN n.name AS name, labels(n) AS labels, n.importance AS importance ORDER BY n.importance DESC LIMIT 25">Top nodes by importance</span>
    <span class="example-chip" data-q="MATCH (n)-[r]-(m) WITH n, count(r) AS degree ORDER BY degree DESC LIMIT 20 RETURN n.name AS name, labels(n) AS labels, degree">Most connected nodes</span>
    <span class="example-chip" data-q="MATCH (n) WHERE n.created_at IS NOT NULL RETURN n.name AS name, labels(n) AS labels, n.created_at AS created ORDER BY n.created_at DESC LIMIT 20">Recently created</span>
    <span class="example-chip" data-q="MATCH (n:Pattern) RETURN n.name AS name, n.description AS description, n.importance AS importance ORDER BY n.importance DESC LIMIT 20">Patterns</span>
  </div>

  <div class="query-area">
    <textarea id="editor" placeholder="Enter Cypher query..." spellcheck="false">MATCH (n) RETURN labels(n) AS type, count(n) AS count ORDER BY count DESC</textarea>
  </div>

  <div class="controls">
    <button class="btn-run" id="runBtn" onclick="runQuery()">Run (Ctrl+Enter)</button>
    <button class="btn-clear" onclick="clearResults()">Clear</button>
    <span class="meta" id="meta"></span>
  </div>

  <div id="error" class="error" style="display:none"></div>
  <div class="results-wrap" id="resultsWrap" style="display:none">
    <table><thead id="thead"></thead><tbody id="tbody"></tbody></table>
  </div>

  <div class="history" id="historySection" style="display:none">
    <h2>History</h2>
    <div id="historyList"></div>
  </div>
</div>

<div class="auth-overlay" id="authOverlay" style="display:none">
  <div class="auth-box">
    <h2>Authenticate</h2>
    <div class="auth-error" id="authError" style="display:none"></div>
    <input type="email" id="authEmail" placeholder="Email" />
    <input type="password" id="authPassword" placeholder="Password" />
    <button class="btn-run" onclick="login()">Login</button>
  </div>
</div>

<script>
const BASE = window.location.pathname.replace(/\\/$/, '')
let token = localStorage.getItem('kg_explorer_token')
let history = JSON.parse(localStorage.getItem('kg_explorer_history') || '[]')

renderHistory()

if (!token) showAuth()
else checkStatus()

document.getElementById('editor').addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runQuery() }
})

document.getElementById('examples').addEventListener('click', e => {
  const chip = e.target.closest('.example-chip')
  if (!chip) return
  document.getElementById('editor').value = chip.dataset.q
})

function showAuth() { document.getElementById('authOverlay').style.display = 'flex' }
function hideAuth() { document.getElementById('authOverlay').style.display = 'none' }

async function login() {
  const email = document.getElementById('authEmail').value
  const password = document.getElementById('authPassword').value
  document.getElementById('authError').style.display = 'none'
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Login failed')
    token = data.token
    localStorage.setItem('kg_explorer_token', token)
    hideAuth()
    checkStatus()
  } catch (err) {
    document.getElementById('authError').textContent = err.message
    document.getElementById('authError').style.display = 'block'
  }
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { ...opts.headers, 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
  })
  if (res.status === 401) { token = null; localStorage.removeItem('kg_explorer_token'); showAuth(); throw new Error('Session expired') }
  return res
}

async function checkStatus() {
  const el = document.getElementById('status')
  try {
    const res = await apiFetch('/status')
    const data = await res.json()
    el.className = 'status ' + (data.connected ? 'connected' : 'disconnected')
  } catch {
    el.className = 'status disconnected'
  }
}

async function runQuery() {
  const cypher = document.getElementById('editor').value.trim()
  if (!cypher) return

  const btn = document.getElementById('runBtn')
  const errorEl = document.getElementById('error')
  const metaEl = document.getElementById('meta')
  btn.disabled = true
  errorEl.style.display = 'none'
  document.getElementById('resultsWrap').style.display = 'none'

  try {
    const res = await apiFetch('/query', { method: 'POST', body: JSON.stringify({ cypher }) })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error)

    addHistory(cypher)
    metaEl.textContent = data.count + ' row' + (data.count !== 1 ? 's' : '') + ' in ' + data.durationMs + 'ms'

    if (data.rows.length === 0) {
      metaEl.textContent = 'No results (' + data.durationMs + 'ms)'
      return
    }

    renderTable(data.keys, data.rows)
  } catch (err) {
    errorEl.textContent = err.message
    errorEl.style.display = 'block'
    metaEl.textContent = ''
  } finally {
    btn.disabled = false
  }
}

function renderTable(keys, rows) {
  const thead = document.getElementById('thead')
  const tbody = document.getElementById('tbody')
  thead.innerHTML = '<tr>' + keys.map(k => '<th>' + esc(k) + '</th>').join('') + '</tr>'
  tbody.innerHTML = rows.map(row =>
    '<tr>' + keys.map(k => '<td>' + formatCell(row[k]) + '</td>').join('') + '</tr>'
  ).join('')
  document.getElementById('resultsWrap').style.display = 'block'
}

function formatCell(val) {
  if (val === null || val === undefined) return '<span class="cell-null">null</span>'
  if (typeof val === 'number') return '<span class="cell-num">' + val + '</span>'
  if (Array.isArray(val)) return esc(val.map(v => typeof v === 'object' ? JSON.stringify(v) : v).join(', '))
  if (typeof val === 'object') {
    if (val._type === 'node') return '<span class="cell-node">' + esc(':' + (val.labels||[]).join(':') + ' ' + JSON.stringify(omit(val, '_type', 'labels'))) + '</span>'
    if (val._type === 'relationship') return '<span class="cell-rel">' + esc('[:'+ val.type + '] ' + JSON.stringify(omit(val, '_type', 'type'))) + '</span>'
    return esc(JSON.stringify(val))
  }
  return esc(String(val))
}

function omit(obj, ...keys) {
  const o = { ...obj }; keys.forEach(k => delete o[k]); return o
}

function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML }

function clearResults() {
  document.getElementById('resultsWrap').style.display = 'none'
  document.getElementById('error').style.display = 'none'
  document.getElementById('meta').textContent = ''
}

function addHistory(q) {
  history = [q, ...history.filter(h => h !== q)].slice(0, 50)
  localStorage.setItem('kg_explorer_history', JSON.stringify(history))
  renderHistory()
}

function renderHistory() {
  const section = document.getElementById('historySection')
  const list = document.getElementById('historyList')
  if (history.length === 0) { section.style.display = 'none'; return }
  section.style.display = 'block'
  list.innerHTML = history.map(q =>
    '<div class="history-item" onclick="loadHistory(this)" data-q="' + esc(q) + '">' + esc(q) + '</div>'
  ).join('')
}

function loadHistory(el) {
  document.getElementById('editor').value = el.dataset.q
}
</script>
</body>
</html>`

module.exports = router
