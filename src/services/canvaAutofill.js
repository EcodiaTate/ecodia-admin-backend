'use strict'

const logger = require('../config/logger')
const canvaService = require('./canvaService')

// ═══════════════════════════════════════════════════════════════════════
// CANVA AUTOFILL ORCHESTRATOR
//
// High-level chains built on top of canvaService.js low-level wrappers.
// Covers: autofill → export pipeline, template discovery with schemas,
// and convenience preview generation.
//
// Do NOT import directly from canvaService internals — use the exported
// functions only. This module is the integration layer; canvaService is
// the transport layer.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Chain autofillBrandTemplate → pollAutofill → exportDesign → pollExport.
 *
 * Each poll step uses canvaService's default 60s timeout, giving 120s total.
 *
 * @param {object} opts
 * @param {string} opts.templateId  - Brand template ID
 * @param {string} [opts.title]     - Design title (optional)
 * @param {object} opts.data        - Autofill data payload { fieldName: value }
 * @param {string} [opts.format]    - Export format: 'pdf' | 'png' | 'jpg' (default: 'pdf')
 * @returns {{ designId, designUrl, exportUrl, exportFormat, durationMs }}
 * @throws {Error} with .step = 'autofill' | 'export' and .canvaJobId on failure
 */
async function autofillAndExport({ templateId, title, data, format = 'pdf' }) {
  const startTime = Date.now()

  // ── Step 1: Autofill ─────────────────────────────────────────────
  let autofillJobId = null
  let autofillResult
  try {
    const autofillJob = await canvaService.autofillBrandTemplate({ templateId, title, data })
    autofillJobId = autofillJob?.job?.id || autofillJob?.id || null
    if (!autofillJobId) throw new Error('Response contained no autofill job ID')
    logger.info('Canva autofill job started', { autofillJobId, templateId })
    autofillResult = await canvaService.pollAutofill(autofillJobId)
  } catch (err) {
    const error = new Error(`Canva autofill failed: ${err.message}`)
    error.step = 'autofill'
    error.canvaJobId = autofillJobId
    throw error
  }

  // Extract design from autofill result
  const designResult = autofillResult?.job?.result?.design || autofillResult?.result?.design || {}
  const designId = designResult.id
  const designUrl = designResult.url || null

  if (!designId) {
    const error = new Error('Canva autofill succeeded but returned no design ID')
    error.step = 'autofill'
    error.canvaJobId = autofillJobId
    throw error
  }

  // ── Step 2: Export ───────────────────────────────────────────────
  let exportJobId = null
  let exportResult
  try {
    const exportJob = await canvaService.exportDesign({ designId, format })
    exportJobId = exportJob?.job?.id || exportJob?.id || null
    if (!exportJobId) throw new Error('Response contained no export job ID')
    logger.info('Canva export job started', { exportJobId, designId, format })
    exportResult = await canvaService.pollExport(exportJobId)
  } catch (err) {
    const error = new Error(`Canva export failed: ${err.message}`)
    error.step = 'export'
    error.canvaJobId = exportJobId
    throw error
  }

  const exportUrl =
    exportResult?.job?.result?.url ||
    exportResult?.job?.result?.urls?.[0] ||
    exportResult?.result?.url ||
    exportResult?.result?.urls?.[0] ||
    null

  return {
    designId,
    designUrl,
    exportUrl,
    exportFormat: format,
    durationMs: Date.now() - startTime,
  }
}

/**
 * List all brand templates with their full dataset schemas.
 *
 * Handles pagination via continuation tokens. Dataset fetch failures per
 * template are captured as { dataset: null, error: string } rather than
 * thrown — a single template failure does not abort the list.
 *
 * @param {object} [opts]
 * @param {number} [opts.limit=50]  - Max templates to return
 * @returns {Array<{ id, title, updated_at, thumbnail_url, dataset, error? }>}
 */
async function listTemplatesWithSchemas({ limit = 50 } = {}) {
  const templates = []
  let continuation = undefined

  while (templates.length < limit) {
    const response = await canvaService.listBrandTemplates({ continuation })
    const items = response?.items || response?.brand_templates || []

    for (const template of items) {
      if (templates.length >= limit) break

      let dataset = null
      let fetchError = null
      try {
        const datasetResponse = await canvaService.getBrandTemplateDataset(template.id)
        // API returns { dataset: { fieldName: { type, ... }, ... } }
        dataset = datasetResponse?.dataset !== undefined
          ? datasetResponse.dataset
          : datasetResponse || null
      } catch (err) {
        fetchError = err.message
        logger.debug('Failed to fetch dataset for template', {
          templateId: template.id,
          error: err.message,
        })
      }

      const entry = {
        id: template.id,
        title: template.title || template.name || null,
        updated_at: template.updated_at || null,
        thumbnail_url: template.thumbnail?.url || template.thumbnail_url || null,
        dataset,
      }
      if (fetchError) entry.error = fetchError
      templates.push(entry)
    }

    continuation = response?.continuation
    if (!continuation || items.length === 0) break
  }

  return templates
}

/**
 * Convenience: fetch one template's schema and generate a skeleton data payload.
 *
 * Useful for morning-Tate to copy-paste and fill in for autofillAndExport calls.
 *
 * @param {object} opts
 * @param {string} opts.templateId
 * @returns {{ id, title, dataset, sampleDataPayload }}
 * @throws {Error} with .status=404 if template not found
 */
async function previewAutofill({ templateId }) {
  // Fetch all templates — limit high enough that target is included.
  // A future optimisation: direct getBrandTemplateDataset if we already know the ID.
  const templates = await listTemplatesWithSchemas({ limit: 200 })
  const template = templates.find(t => t.id === templateId)

  if (!template) {
    const err = new Error(`Template not found: ${templateId}`)
    err.status = 404
    throw err
  }

  // Build skeleton payload with right-typed placeholder per field
  const sampleDataPayload = {}
  if (template.dataset && typeof template.dataset === 'object') {
    for (const [fieldName, fieldDef] of Object.entries(template.dataset)) {
      const type = fieldDef?.type
      if (type === 'image') {
        sampleDataPayload[fieldName] = { type: 'image', asset_id: 'REPLACE_ME' }
      } else if (type === 'chart') {
        sampleDataPayload[fieldName] = { type: 'chart', chart_data: 'REPLACE_ME' }
      } else {
        sampleDataPayload[fieldName] = { type: 'text', text: 'SAMPLE_TEXT' }
      }
    }
  }

  return {
    id: template.id,
    title: template.title,
    dataset: template.dataset,
    sampleDataPayload,
  }
}

module.exports = { autofillAndExport, listTemplatesWithSchemas, previewAutofill }
