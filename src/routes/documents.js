/**
 * Document generation routes.
 * POST /api/docs/render   — generate HTML + PDF, upload to Supabase Storage
 * POST /api/docs/render-html — render arbitrary HTML string, upload to Storage
 * GET  /api/docs/files/*  — serve locally generated files (fallback)
 * GET  /api/docs/preview/:slug — return raw HTML for iframe rendering
 */
const express = require('express')
const path = require('path')
const fs = require('fs')
const env = require('../config/env')
const router = express.Router()

const DOCS_DIR = path.join(__dirname, '../../public/docs')
const API_BASE = env.API_BASE_URL || 'https://api.admin.ecodia.au'

// Lazy Supabase client for storage uploads
let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  if (!env.SUPABASE_URL || !(env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY)) return null
  const { createClient } = require('@supabase/supabase-js')
  _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY || env.SUPABASE_ANON_KEY)
  return _supabase
}

async function uploadToStorage(slug, buffer, contentType) {
  const sb = getSupabase()
  if (!sb) return null
  try {
    await sb.storage.createBucket('documents', { public: true }).catch(() => {})
    const { error } = await sb.storage.from('documents').upload(`${slug}`, buffer, { contentType, upsert: true })
    if (error) return null
    const { data } = sb.storage.from('documents').getPublicUrl(`${slug}`)
    return data?.publicUrl || null
  } catch { return null }
}

// Ensure docs dir exists
fs.mkdirSync(DOCS_DIR, { recursive: true })

// Serve generated documents (fallback local serving)
router.use('/files', express.static(DOCS_DIR))

// Return raw HTML for iframe preview
router.get('/preview/:slug', (req, res) => {
  const slug = req.params.slug.replace(/[^a-zA-Z0-9_-]/g, '')
  const htmlPath = path.join(DOCS_DIR, `${slug}.html`)
  if (!fs.existsSync(htmlPath)) return res.status(404).send('Not found')
  res.setHeader('Content-Type', 'text/html')
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.send(fs.readFileSync(htmlPath))
})

// Render arbitrary HTML string and return download URL
router.post('/render-html', async (req, res) => {
  const { html, filename, title } = req.body
  if (!html) return res.status(400).json({ error: 'html required' })

  const slug = (filename || `html-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
  const htmlPath = path.join(DOCS_DIR, `${slug}.html`)
  fs.writeFileSync(htmlPath, html)

  // Upload HTML to Supabase Storage
  const storageUrl = await uploadToStorage(`${slug}.html`, Buffer.from(html, 'utf8'), 'text/html')
  const localUrl = `${API_BASE}/api/docs/files/${slug}.html`
  const previewUrl = `${API_BASE}/api/docs/preview/${slug}`

  res.json({
    html: storageUrl || localUrl,
    preview: previewUrl,
    slug,
    title: title || slug,
  })
})

// Generate a document (HTML + PDF) from structured spec
router.post('/render', async (req, res) => {
  const { title, type, sections, metadata, filename } = req.body
  if (!title || !sections) {
    return res.status(400).json({ error: 'title and sections required' })
  }

  const slug = (filename || `doc-${Date.now()}`).replace(/[^a-zA-Z0-9_-]/g, '-')
  const html = buildHtml(title, type, sections, metadata)
  const htmlPath = path.join(DOCS_DIR, `${slug}.html`)
  const pdfPath = path.join(DOCS_DIR, `${slug}.pdf`)

  fs.writeFileSync(htmlPath, html)

  // Upload HTML to Supabase Storage
  const htmlStorageUrl = await uploadToStorage(`${slug}.html`, Buffer.from(html, 'utf8'), 'text/html')
  const htmlLocalUrl = `${API_BASE}/api/docs/files/${slug}.html`
  const previewUrl = `${API_BASE}/api/docs/preview/${slug}`

  // Generate PDF via puppeteer
  try {
    const puppeteer = require('puppeteer')
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }, printBackground: true })
    await browser.close()

    // Upload PDF to Supabase Storage
    const pdfBuffer = fs.readFileSync(pdfPath)
    const pdfStorageUrl = await uploadToStorage(`${slug}.pdf`, pdfBuffer, 'application/pdf')
    const pdfLocalUrl = `${API_BASE}/api/docs/files/${slug}.pdf`

    res.json({
      html: htmlStorageUrl || htmlLocalUrl,
      pdf: pdfStorageUrl || pdfLocalUrl,
      preview: previewUrl,
      filename: slug,
      // download:// links for the OS to output in chat
      downloadHtml: `download://${htmlStorageUrl || htmlLocalUrl}`,
      downloadPdf: `download://${pdfStorageUrl || pdfLocalUrl}`,
    })
  } catch (err) {
    res.json({
      html: htmlStorageUrl || htmlLocalUrl,
      pdf: null,
      preview: previewUrl,
      filename: slug,
      downloadHtml: `download://${htmlStorageUrl || htmlLocalUrl}`,
      error: `PDF generation failed: ${err.message}`,
    })
  }
})

function buildHtml(title, type, sections, metadata) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; background: #fff; line-height: 1.6; font-size: 14px; }
    .page { max-width: 800px; margin: 0 auto; padding: 48px 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 24px; border-bottom: 2px solid #000; }
    .brand { display: inline-flex; }
    .brand-eco { background: #000; color: #fff; padding: 5px 7px; font-size: 11px; font-weight: 800; letter-spacing: 0.15em; }
    .brand-code { background: #fff; color: #000; padding: 5px 7px; font-size: 11px; font-weight: 800; letter-spacing: 0.15em; }
    .inv-number { font-size: 11px; color: #999; letter-spacing: 0.1em; margin-top: 12px; }
    .inv-title { font-size: 28px; font-weight: 300; margin-top: 4px; }
    .meta { font-size: 12px; color: #666; text-align: right; line-height: 1.8; }
    .meta strong { color: #111; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 10px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: #999; margin-bottom: 12px; }
    .section-content { font-size: 13px; line-height: 1.8; white-space: pre-line; }
    table { width: 100%; border-collapse: collapse; margin: 0 0 8px 0; }
    th { text-align: left; font-size: 10px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #999; padding: 10px 0; border-bottom: 1px solid #ddd; }
    th.amount { text-align: right; }
    td { padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    td.amount { text-align: right; font-weight: 500; }
    tr.total td { border-top: 2px solid #000; border-bottom: none; font-weight: 700; font-size: 18px; padding-top: 16px; }
    .note { font-size: 12px; color: #999; }
    .payment { background: #fafafa; padding: 24px; margin-bottom: 32px; }
    .payment-label { font-size: 10px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: #999; margin-bottom: 12px; }
    .payment-grid { display: grid; grid-template-columns: auto 1fr; gap: 4px 20px; font-size: 13px; }
    .payment-grid dt { color: #999; } .payment-grid dd { color: #111; }
    .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 10px; color: #ccc; display: flex; justify-content: space-between; letter-spacing: 0.1em; text-transform: uppercase; }
    @media print { body { padding: 0; } .page { padding: 24px; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand"><span class="brand-eco">ECODIA</span><span class="brand-code">CODE</span></div>
        ${type ? `<p class="inv-number">${esc(type)}</p>` : ''}
        <h1 class="inv-title">${esc(title)}</h1>
      </div>
      <div class="meta">
        ${(metadata || []).map(m => { const s = String(m); return `<div>${s.includes(':') ? '<strong>' + esc(s.split(':')[0]) + ':</strong>' + esc(s.split(':').slice(1).join(':')) : esc(s)}</div>`; }).join('')}
      </div>
    </div>
    ${sections.map(s => renderSection(s)).join('')}
    <div class="footer">
      <span>ECODIA CODE</span>
      <span>ecodia.au</span>
    </div>
  </div>
</body>
</html>`
}

function renderSection(s) {
  if (s.type === 'text') {
    return `<div class="section">${s.title ? `<div class="section-title">${esc(s.title)}</div>` : ''}<div class="section-content">${esc(s.content || '')}</div></div>`
  }
  if (s.type === 'note') {
    return `<p class="note">${esc(s.content || '')}</p>`
  }
  if (s.type === 'payment') {
    const entries = Object.entries(s.details || {})
    return `<div class="payment"><p class="payment-label">${esc(s.title || 'Payment Details')}</p><dl class="payment-grid">${entries.map(([k,v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl></div>`
  }
  if (s.type === 'table') {
    const headers = s.headers || []
    const rows = s.rows || []
    return `<div class="section">
      ${s.title ? `<div class="section-title">${esc(s.title)}</div>` : ''}
      <table>
        <thead><tr>${headers.map(h => {
          const label = typeof h === 'string' ? h : h.label
          const align = typeof h === 'object' && h.align === 'right' ? ' class="amount"' : ''
          return `<th${align}>${esc(label)}</th>`
        }).join('')}</tr></thead>
        <tbody>${rows.map(r => {
          const cls = r.total ? ' class="total"' : ''
          return `<tr${cls}>${r.cells.map((c, i) => {
            const align = typeof headers[i] === 'object' && headers[i].align === 'right' ? ' class="amount"' : ''
            return `<td${align}>${esc(String(c))}</td>`
          }).join('')}</tr>`
        }).join('')}</tbody>
      </table>
    </div>`
  }
  if (s.type === 'html') {
    return `<div class="section">${s.content}</div>`
  }
  return ''
}

function esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

module.exports = router
