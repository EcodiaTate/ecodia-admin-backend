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

// Generate a project proposal from structured input
router.post('/proposal', async (req, res) => {
  const { clientName, contactName, projectTitle, summary, features, notIncluded, timeline, price, paymentTerms, validFor } = req.body
  if (!clientName || !projectTitle || !summary || !features) {
    return res.status(400).json({ error: 'clientName, projectTitle, summary, and features are required' })
  }

  const slug = `proposal-${projectTitle.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${Date.now()}`
  const html = buildProposalHtml({ clientName, contactName, projectTitle, summary, features, notIncluded, timeline, price, paymentTerms, validFor })
  const htmlPath = path.join(DOCS_DIR, `${slug}.html`)
  fs.writeFileSync(htmlPath, html)

  const htmlStorageUrl = await uploadToStorage(`${slug}.html`, Buffer.from(html, 'utf8'), 'text/html')
  const htmlLocalUrl = `${API_BASE}/api/docs/files/${slug}.html`
  const previewUrl = `${API_BASE}/api/docs/preview/${slug}`

  try {
    const puppeteer = require('puppeteer')
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfPath = path.join(DOCS_DIR, `${slug}.pdf`)
    await page.pdf({ path: pdfPath, format: 'A4', margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' }, printBackground: true })
    await browser.close()

    const pdfBuffer = fs.readFileSync(pdfPath)
    const pdfStorageUrl = await uploadToStorage(`${slug}.pdf`, pdfBuffer, 'application/pdf')
    const pdfLocalUrl = `${API_BASE}/api/docs/files/${slug}.pdf`

    res.json({
      html: htmlStorageUrl || htmlLocalUrl,
      pdf: pdfStorageUrl || pdfLocalUrl,
      preview: previewUrl,
      filename: slug,
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

// Generate a pitch deck from structured input
router.post('/pitch-deck', async (req, res) => {
  const { orgName, orgDescription, problem, problemPoints, solution, solutionPoints, whyEcodia, investment, timeline, nextSteps, ourWork, teamCredibility, techStack, approach, callToAction, accentColor } = req.body
  if (!orgName || !problem || !solution) {
    return res.status(400).json({ error: 'orgName, problem, and solution are required' })
  }

  const slug = `pitch-${orgName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()}-${Date.now()}`
  const html = buildPitchDeckHtml({ orgName, orgDescription, problem, problemPoints, solution, solutionPoints, whyEcodia, investment, timeline, nextSteps, ourWork, teamCredibility, techStack, approach, callToAction, accentColor })
  const htmlPath = path.join(DOCS_DIR, `${slug}.html`)
  fs.writeFileSync(htmlPath, html)

  const htmlStorageUrl = await uploadToStorage(`${slug}.html`, Buffer.from(html, 'utf8'), 'text/html')
  const htmlLocalUrl = `${API_BASE}/api/docs/files/${slug}.html`
  const previewUrl = `${API_BASE}/api/docs/preview/${slug}`

  try {
    const puppeteer = require('puppeteer')
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
    const page = await browser.newPage()
    await page.setContent(html, { waitUntil: 'networkidle0' })
    const pdfPath = path.join(DOCS_DIR, `${slug}.pdf`)
    await page.pdf({ path: pdfPath, width: '1280px', height: '720px', printBackground: true, landscape: true })
    await browser.close()

    const pdfBuffer = fs.readFileSync(pdfPath)
    const pdfStorageUrl = await uploadToStorage(`${slug}.pdf`, pdfBuffer, 'application/pdf')
    const pdfLocalUrl = `${API_BASE}/api/docs/files/${slug}.pdf`

    res.json({
      html: htmlStorageUrl || htmlLocalUrl,
      pdf: pdfStorageUrl || pdfLocalUrl,
      preview: previewUrl,
      filename: slug,
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

function buildPitchDeckHtml({ orgName, orgDescription, problem, problemPoints, solution, solutionPoints, whyEcodia, investment, timeline, nextSteps, ourWork, teamCredibility, techStack, approach, callToAction, accentColor }) {
  const accent = accentColor || '#1a7a3a'
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  const slideFooter = `<div class="slide-footer"><span>Ecodia Pty Ltd &nbsp;&bull;&nbsp; ABN 86 688 476 082</span><span>code@ecodia.au &nbsp;&bull;&nbsp; ecodia.au</span></div>`

  const problemPointsHtml = (problemPoints || []).map(p => `<div class="point-card"><div class="point-icon">&#9679;</div><p>${esc(p)}</p></div>`).join('')
  const solutionPointsHtml = (solutionPoints || []).map((s, i) => `<div class="solution-card"><div class="solution-num">${String(i + 1).padStart(2, '0')}</div><p>${esc(s)}</p></div>`).join('')
  const whyEcodiaHtml = (whyEcodia || []).map((w, i) => `<div class="why-item"><span class="why-num">0${i + 1}</span><span>${esc(w)}</span></div>`).join('')
  const teamCredibilityHtml = (teamCredibility || []).map(t => `<div class="cred-item"><div class="cred-check">&#10003;</div><span>${esc(t)}</span></div>`).join('')
  const ourWorkHtml = (ourWork || []).map(w => `<div class="work-card"><div class="work-status">${esc(w.status || '')}</div><h4>${esc(w.name)}</h4><p>${esc(w.description)}</p></div>`).join('')
  const approachHtml = (approach || []).map((step, i) => `<div class="step-item"><div class="step-num">${String(i + 1).padStart(2, '0')}</div><div class="step-line"></div><p>${esc(step)}</p></div>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pitch Deck - ${esc(orgName)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', system-ui, -apple-system, Arial, sans-serif; color: #111111; background: #ffffff; }
    .slide { min-height: 100vh; display: flex; flex-direction: column; justify-content: center; padding: 80px 100px 80px; position: relative; page-break-after: always; }
    .slide::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: 4px; background: ${accent}; }
    .slide-footer { position: absolute; bottom: 32px; left: 100px; right: 100px; font-size: 10px; color: #999; letter-spacing: 0.1em; text-transform: uppercase; border-top: 1px solid #e8e8e8; padding-top: 16px; display: flex; justify-content: space-between; }
    .slide-divider { width: 100%; height: 1px; background: linear-gradient(to right, ${accent}22, ${accent}88, ${accent}22); margin: 0; }
    .section-label { font-size: 11px; font-weight: 700; letter-spacing: 0.35em; text-transform: uppercase; color: ${accent}; margin-bottom: 16px; display: flex; align-items: center; gap: 12px; }
    .section-label::after { content: ''; flex: 1; height: 1px; background: #e0e0e0; }
    .slide-title { font-size: 38px; font-weight: 300; margin-bottom: 32px; letter-spacing: -0.02em; color: #111; line-height: 1.2; }
    .slide-body { font-size: 17px; color: #555; line-height: 1.85; max-width: 640px; margin-bottom: 40px; }

    /* SLIDE 1: Hero */
    .hero-slide { background: #fafafa; }
    .badge { display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: 0.25em; text-transform: uppercase; padding: 8px 20px; border: 2px solid ${accent}; color: ${accent}; margin-bottom: 48px; }
    .hero-prepared { font-size: 13px; font-weight: 500; letter-spacing: 0.15em; text-transform: uppercase; color: #999; margin-bottom: 20px; }
    .hero-org { font-size: 52px; font-weight: 200; line-height: 1.15; margin-bottom: 20px; letter-spacing: -0.03em; color: #111; }
    .hero-tagline { font-size: 22px; font-weight: 300; color: #666; line-height: 1.6; max-width: 600px; }
    .hero-desc { font-size: 15px; color: #888; margin-top: 32px; max-width: 520px; line-height: 1.8; }
    .hero-date { font-size: 12px; color: #bbb; margin-top: 40px; letter-spacing: 0.1em; }

    /* SLIDE 2: Problem */
    .point-card { background: #f7f7f7; border-left: 3px solid #ddd; padding: 20px 24px; margin-bottom: 12px; display: flex; align-items: flex-start; gap: 16px; }
    .point-card p { font-size: 16px; color: #444; line-height: 1.6; font-weight: 400; }
    .point-icon { color: #cc4444; font-size: 8px; margin-top: 7px; flex-shrink: 0; }

    /* SLIDE 3: Solution */
    .solution-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .solution-card { background: #ffffff; border: 1px solid #e8e8e8; padding: 24px; border-radius: 4px; }
    .solution-card:hover { border-color: ${accent}; }
    .solution-num { font-size: 28px; font-weight: 200; color: ${accent}; margin-bottom: 12px; }
    .solution-card p { font-size: 15px; color: #555; line-height: 1.6; }

    /* SLIDE 4: Track Record */
    .work-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px; margin-top: 8px; }
    .work-card { background: #fafafa; border: 1px solid #eee; padding: 28px 24px; border-radius: 4px; position: relative; }
    .work-card h4 { font-size: 20px; font-weight: 500; color: #111; margin-bottom: 12px; }
    .work-card p { font-size: 14px; color: #666; line-height: 1.7; }
    .work-status { display: inline-block; font-size: 10px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: ${accent}; background: ${accent}11; padding: 4px 10px; border-radius: 2px; margin-bottom: 16px; }
    .tech-note { margin-top: 32px; padding: 20px 24px; background: #f5f5f5; border-left: 3px solid ${accent}; font-size: 14px; color: #666; line-height: 1.7; }
    .tech-note strong { color: #333; }

    /* SLIDE 5: Why Us */
    .why-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
    .why-item { display: flex; align-items: flex-start; gap: 20px; padding: 24px 24px 24px 0; border-bottom: 1px solid #eee; }
    .why-item:nth-child(even) { padding-left: 24px; border-left: 1px solid #eee; }
    .why-item:last-child, .why-item:nth-last-child(2):nth-child(odd) { border-bottom: none; }
    .why-num { font-size: 11px; font-weight: 800; color: ${accent}; letter-spacing: 0.1em; flex-shrink: 0; margin-top: 2px; background: ${accent}11; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center; border-radius: 50%; }
    .why-item span:last-child { font-size: 16px; font-weight: 400; line-height: 1.6; color: #444; }
    .cred-section { margin-top: 40px; padding-top: 32px; border-top: 1px solid #eee; }
    .cred-title { font-size: 13px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: #999; margin-bottom: 20px; }
    .cred-item { display: flex; align-items: flex-start; gap: 14px; padding: 10px 0; font-size: 15px; color: #444; line-height: 1.5; }
    .cred-check { color: ${accent}; font-size: 14px; font-weight: 700; flex-shrink: 0; margin-top: 1px; }

    /* SLIDE 6: How We Work */
    .steps-timeline { position: relative; padding-left: 0; }
    .step-item { display: flex; align-items: flex-start; gap: 24px; padding: 24px 0; position: relative; }
    .step-item:not(:last-child) { border-bottom: 1px solid #f0f0f0; }
    .step-num { font-size: 24px; font-weight: 200; color: ${accent}; flex-shrink: 0; width: 48px; height: 48px; border: 2px solid ${accent}22; border-radius: 50%; display: flex; align-items: center; justify-content: center; }
    .step-item p { font-size: 17px; color: #444; line-height: 1.6; padding-top: 10px; }

    /* SLIDE 7: Investment */
    .invest-slide { background: #fafafa; }
    .invest-hero { display: flex; align-items: baseline; gap: 16px; margin-bottom: 8px; }
    .invest-price { font-size: 56px; font-weight: 200; color: ${accent}; }
    .invest-timeline { font-size: 18px; color: #888; font-weight: 300; }
    .invest-detail { margin-top: 24px; margin-bottom: 48px; font-size: 15px; color: #888; line-height: 1.7; max-width: 500px; }
    .invest-cta { font-size: 18px; font-weight: 400; color: #333; line-height: 1.8; max-width: 560px; padding: 32px; background: #ffffff; border: 2px solid ${accent}33; border-radius: 4px; }
    .invest-cta strong { color: ${accent}; }

    @media print {
      .slide { padding: 60px 80px; }
      .slide-footer { bottom: 24px; left: 80px; right: 80px; }
    }
  </style>
</head>
<body>
  <!-- SLIDE 1: Title -->
  <div class="slide hero-slide">
    <div class="badge">ECODIA</div>
    <p class="hero-prepared">Prepared for</p>
    <h1 class="hero-org">${esc(orgName)}</h1>
    <p class="hero-tagline">Technology that amplifies your impact</p>
${orgDescription ? `    <p class="hero-desc">${esc(orgDescription)}</p>` : ''}
    <p class="hero-date">${date}</p>
    ${slideFooter}
  </div>

  <!-- SLIDE 2: Problem -->
  <div class="slide">
    <div class="section-label">01 &nbsp; The Problem</div>
    <h2 class="slide-title">What's holding you back</h2>
    <div class="slide-body">${esc(problem)}</div>
    ${problemPointsHtml ? `<div class="points-list">${problemPointsHtml}</div>` : ''}
    ${slideFooter}
  </div>

  <!-- SLIDE 3: Solution -->
  <div class="slide">
    <div class="section-label">02 &nbsp; The Solution</div>
    <h2 class="slide-title">What we'll build together</h2>
    <div class="slide-body">${esc(solution)}</div>
    ${solutionPointsHtml ? `<div class="solution-grid">${solutionPointsHtml}</div>` : ''}
    ${slideFooter}
  </div>

${ourWork && ourWork.length ? `  <!-- SLIDE 4: Track Record -->
  <div class="slide">
    <div class="section-label">03 &nbsp; Our Track Record</div>
    <h2 class="slide-title">Proven delivery in conservation tech</h2>
    <div class="work-grid">${ourWorkHtml}</div>
${techStack ? `    <div class="tech-note"><strong>Built with:</strong> ${esc(techStack)}</div>` : ''}
    ${slideFooter}
  </div>
` : ''}
${whyEcodia && whyEcodia.length ? `  <!-- SLIDE 5: Why Us -->
  <div class="slide">
    <div class="section-label">04 &nbsp; Why Ecodia</div>
    <h2 class="slide-title">The right team for this</h2>
    <div class="why-grid">${whyEcodiaHtml}</div>
${teamCredibilityHtml ? `    <div class="cred-section"><div class="cred-title">Specifically for ${esc(orgName)}</div>${teamCredibilityHtml}</div>` : ''}
    ${slideFooter}
  </div>
` : ''}
${approach && approach.length ? `  <!-- SLIDE 6: How We Work -->
  <div class="slide">
    <div class="section-label">05 &nbsp; How We Work</div>
    <h2 class="slide-title">From conversation to launch</h2>
    <div class="steps-timeline">${approachHtml}</div>
    ${slideFooter}
  </div>
` : ''}
  <!-- SLIDE 7: Investment -->
  <div class="slide invest-slide">
    <div class="section-label">06 &nbsp; Investment</div>
    <h2 class="slide-title">Let's make it happen</h2>
${investment || timeline ? `    <div class="invest-hero">
${investment ? `      <div class="invest-price">${esc(investment)}</div>` : ''}
${timeline ? `      <div class="invest-timeline">${esc(timeline)}</div>` : ''}
    </div>
    <p class="invest-detail">Fixed price. No hourly surprises. One round of revisions included.</p>` : ''}
${nextSteps || callToAction ? `    <div class="invest-cta">${esc(callToAction || nextSteps)}</div>` : ''}
    ${slideFooter}
  </div>
</body>
</html>`
}

function buildProposalHtml({ clientName, contactName, projectTitle, summary, features, notIncluded, timeline, price, paymentTerms, validFor }) {
  const date = new Date().toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' })
  const greeting = contactName ? `Hi ${esc(contactName)},` : `Hi ${esc(clientName)},`
  const featuresHtml = (features || []).map(f => `<li>${esc(f)}</li>`).join('')
  const notIncludedHtml = (notIncluded || []).map(n => `<li>${esc(n)}</li>`).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proposal - ${esc(projectTitle)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #1a1a1a; background: #fff; line-height: 1.7; font-size: 14px; }
    .page { max-width: 720px; margin: 0 auto; padding: 56px 48px; }
    .header { margin-bottom: 48px; padding-bottom: 24px; border-bottom: 2px solid #111; }
    .brand { display: inline-flex; margin-bottom: 8px; }
    .brand-eco { background: #000; color: #fff; padding: 5px 8px; font-size: 12px; font-weight: 800; letter-spacing: 0.15em; }
    .brand-tagline { font-size: 11px; color: #999; letter-spacing: 0.08em; margin-top: 4px; }
    .header-meta { font-size: 12px; color: #666; margin-top: 16px; line-height: 1.8; }
    .title { font-size: 26px; font-weight: 300; margin: 24px 0 8px; letter-spacing: -0.01em; }
    .subtitle { font-size: 13px; color: #888; }
    .greeting { margin: 32px 0 16px; font-size: 14px; }
    .section { margin-bottom: 32px; }
    .section-title { font-size: 10px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: #999; margin-bottom: 12px; padding-bottom: 6px; border-bottom: 1px solid #eee; }
    .section-body { font-size: 14px; line-height: 1.8; color: #333; }
    .feature-list { list-style: none; padding: 0; }
    .feature-list li { padding: 8px 0 8px 24px; position: relative; border-bottom: 1px solid #f5f5f5; }
    .feature-list li:last-child { border-bottom: none; }
    .feature-list li::before { content: ''; position: absolute; left: 0; top: 16px; width: 8px; height: 8px; background: #111; border-radius: 50%; }
    .excluded-list { list-style: none; padding: 0; }
    .excluded-list li { padding: 6px 0 6px 24px; position: relative; color: #888; font-size: 13px; }
    .excluded-list li::before { content: ''; position: absolute; left: 2px; top: 14px; width: 12px; height: 2px; background: #ccc; }
    .investment-box { background: #fafafa; padding: 28px; margin-bottom: 32px; }
    .investment-price { font-size: 32px; font-weight: 300; color: #111; margin-bottom: 8px; }
    .investment-terms { font-size: 13px; color: #666; line-height: 1.8; }
    .timeline-box { display: inline-block; background: #111; color: #fff; padding: 10px 20px; font-size: 13px; font-weight: 600; letter-spacing: 0.05em; margin-bottom: 8px; }
    .next-steps { background: #f9f9f9; padding: 24px; font-size: 14px; line-height: 1.8; color: #333; }
    .valid-note { font-size: 12px; color: #aaa; margin-top: 24px; font-style: italic; }
    .footer { margin-top: 48px; padding-top: 16px; border-top: 1px solid #eee; font-size: 10px; color: #bbb; display: flex; justify-content: space-between; letter-spacing: 0.1em; text-transform: uppercase; }
    @media print { body { padding: 0; } .page { padding: 24px; } }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="brand"><span class="brand-eco">ECODIA</span></div>
      <div class="brand-tagline">The world we build next</div>
      <div class="header-meta">code@ecodia.au</div>
      <h1 class="title">${esc(projectTitle)}</h1>
      <p class="subtitle">Proposal for ${esc(clientName)} &mdash; ${date}</p>
    </div>

    <p class="greeting">${greeting}</p>

    <div class="section">
      <div class="section-title">Summary</div>
      <div class="section-body">${esc(summary)}</div>
    </div>

    <div class="section">
      <div class="section-title">What We'll Build</div>
      <ul class="feature-list">${featuresHtml}</ul>
    </div>

${notIncludedHtml ? `    <div class="section">
      <div class="section-title">What's Not Included</div>
      <ul class="excluded-list">${notIncludedHtml}</ul>
    </div>
` : ''}
${timeline ? `    <div class="section">
      <div class="section-title">Timeline</div>
      <div class="timeline-box">${esc(timeline)}</div>
    </div>
` : ''}
${price ? `    <div class="investment-box">
      <div class="section-title" style="border: none; padding: 0; margin-bottom: 16px;">Investment</div>
      <div class="investment-price">${esc(price)}</div>
${paymentTerms ? `      <div class="investment-terms">${esc(paymentTerms)}</div>` : ''}
    </div>
` : ''}
    <div class="section">
      <div class="section-title">Next Steps</div>
      <div class="next-steps">Reply to this proposal to confirm and we'll send a payment link to get started. Once payment is received, we'll kick off immediately.</div>
    </div>

${validFor ? `    <p class="valid-note">This proposal is valid for ${esc(validFor)} from the date above.</p>` : ''}

    <div class="footer">
      <span>Ecodia Pty Ltd | ABN 86 688 476 082</span>
      <span>ecodia.au</span>
    </div>
  </div>
</body>
</html>`
}

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
