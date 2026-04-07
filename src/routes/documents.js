/**
 * Document generation routes - HTML documents for reports, invoices, etc.
 * These render as styled HTML pages that can be printed to PDF from the browser.
 * POST body contains the document spec, returns styled HTML.
 */
const express = require('express')
const router = express.Router()

router.post('/render', (req, res) => {
  const { title, type, sections, metadata } = req.body
  if (!title || !sections) {
    return res.status(400).json({ error: 'title and sections required' })
  }

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, Helvetica, sans-serif; color: #111; background: #fff; line-height: 1.6; font-size: 14px; }
    .page { max-width: 800px; margin: 0 auto; padding: 48px 40px; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 40px; padding-bottom: 20px; border-bottom: 2px solid #000; }
    .brand { font-size: 11px; font-weight: 800; letter-spacing: 0.15em; text-transform: uppercase; }
    .brand-eco { background: #000; color: #fff; padding: 4px 6px; display: inline-block; }
    .brand-code { background: #fff; color: #000; padding: 4px 6px; display: inline-block; }
    .title { font-size: 24px; font-weight: 300; margin-bottom: 4px; }
    .subtitle { font-size: 12px; color: #666; letter-spacing: 0.05em; text-transform: uppercase; }
    .meta { font-size: 11px; color: #999; text-align: right; }
    .meta div { margin-bottom: 2px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #999; margin-bottom: 12px; }
    .section-content { font-size: 14px; line-height: 1.7; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0; }
    th { text-align: left; font-size: 11px; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; color: #999; padding: 8px 0; border-bottom: 1px solid #ddd; }
    td { padding: 10px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; }
    .amount { text-align: right; font-weight: 600; }
    .total-row td { border-top: 2px solid #000; border-bottom: none; font-weight: 700; font-size: 16px; padding-top: 12px; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #bbb; display: flex; justify-content: space-between; }
    @media print { body { padding: 0; } .page { padding: 20px; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="brand"><span class="brand-eco">ECODIA</span><span class="brand-code">CODE</span></div>
        <h1 class="title" style="margin-top: 16px;">${escHtml(title)}</h1>
        ${type ? `<p class="subtitle">${escHtml(type)}</p>` : ''}
      </div>
      <div class="meta">
        ${(metadata || []).map(m => `<div>${escHtml(m)}</div>`).join('')}
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

  res.type('text/html').send(html)
})

function renderSection(s) {
  if (s.type === 'text') {
    return `<div class="section"><div class="section-title">${escHtml(s.title || '')}</div><div class="section-content">${escHtml(s.content || '')}</div></div>`
  }
  if (s.type === 'table') {
    const headers = s.headers || []
    const rows = s.rows || []
    return `<div class="section">
      ${s.title ? `<div class="section-title">${escHtml(s.title)}</div>` : ''}
      <table>
        <thead><tr>${headers.map(h => `<th${h.align === 'right' ? ' class="amount"' : ''}>${escHtml(h.label || h)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map(r => `<tr${r.total ? ' class="total-row"' : ''}>${r.cells.map((c, i) => `<td${headers[i]?.align === 'right' ? ' class="amount"' : ''}>${escHtml(String(c))}</td>`).join('')}</tr>`).join('')}</tbody>
      </table>
    </div>`
  }
  if (s.type === 'html') {
    return `<div class="section">${s.content}</div>`
  }
  return ''
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

module.exports = router
