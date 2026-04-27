'use strict'

/**
 * canvaAutofill.js tests
 *
 * Covers:
 *   autofillAndExport:
 *     - happy path: all fields returned, durationMs > 0
 *     - autofill-fails path: throws with step='autofill' and canvaJobId populated
 *     - export-fails path: throws with step='export'
 *
 *   listTemplatesWithSchemas:
 *     - 0 templates: returns []
 *     - 3 templates, 1 dataset fetch failing: 3 entries, one with dataset:null + error
 *     - pagination: respects limit when continuation returns more
 *
 *   previewAutofill:
 *     - sampleDataPayload has right-typed placeholders for text/image/chart fields
 */

jest.mock('../src/services/canvaService')

const canvaService = require('../src/services/canvaService')
const { autofillAndExport, listTemplatesWithSchemas, previewAutofill } = require('../src/services/canvaAutofill')

beforeEach(() => jest.clearAllMocks())

// ── autofillAndExport ──────────────────────────────────────────────────────────

describe('autofillAndExport', () => {
  test('happy path returns all required fields and durationMs > 0', async () => {
    canvaService.autofillBrandTemplate.mockResolvedValue({ job: { id: 'autofill-job-1' } })
    canvaService.pollAutofill.mockResolvedValue({
      job: {
        id: 'autofill-job-1',
        status: 'success',
        result: { design: { id: 'design-abc', url: 'https://canva.com/design/abc' } },
      },
    })
    canvaService.exportDesign.mockResolvedValue({ job: { id: 'export-job-1' } })
    canvaService.pollExport.mockResolvedValue({
      job: {
        id: 'export-job-1',
        status: 'success',
        result: { url: 'https://export.canva.com/file.pdf' },
      },
    })

    const result = await autofillAndExport({ templateId: 'tmpl-1', data: { field: 'value' } })

    expect(result.designId).toBe('design-abc')
    expect(result.designUrl).toBe('https://canva.com/design/abc')
    expect(result.exportUrl).toBe('https://export.canva.com/file.pdf')
    expect(result.exportFormat).toBe('pdf')
    expect(typeof result.durationMs).toBe('number')
    expect(result.durationMs).toBeGreaterThan(0)
  })

  test('autofill-fails: throws with step=autofill and canvaJobId set', async () => {
    canvaService.autofillBrandTemplate.mockResolvedValue({ job: { id: 'autofill-job-fail' } })
    canvaService.pollAutofill.mockRejectedValue(new Error('Job timed out'))

    let thrown
    try {
      await autofillAndExport({ templateId: 'tmpl-1', data: {} })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(thrown.step).toBe('autofill')
    expect(thrown.canvaJobId).toBe('autofill-job-fail')
  })

  test('export-fails: throws with step=export', async () => {
    canvaService.autofillBrandTemplate.mockResolvedValue({ job: { id: 'autofill-job-3' } })
    canvaService.pollAutofill.mockResolvedValue({
      job: {
        id: 'autofill-job-3',
        status: 'success',
        result: { design: { id: 'design-xyz' } },
      },
    })
    canvaService.exportDesign.mockResolvedValue({ job: { id: 'export-job-3' } })
    canvaService.pollExport.mockRejectedValue(new Error('Export service unavailable'))

    let thrown
    try {
      await autofillAndExport({ templateId: 'tmpl-1', data: {} })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(thrown.step).toBe('export')
  })
})

// ── listTemplatesWithSchemas ───────────────────────────────────────────────────

describe('listTemplatesWithSchemas', () => {
  test('returns [] when no templates exist', async () => {
    canvaService.listBrandTemplates.mockResolvedValue({ items: [] })

    const result = await listTemplatesWithSchemas()

    expect(result).toEqual([])
  })

  test('3 templates with 1 dataset failure: returns 3 entries, one with dataset:null + error', async () => {
    const templates = [
      { id: 't1', title: 'Template 1' },
      { id: 't2', title: 'Template 2' },
      { id: 't3', title: 'Template 3' },
    ]
    canvaService.listBrandTemplates.mockResolvedValue({ items: templates })
    canvaService.getBrandTemplateDataset
      .mockResolvedValueOnce({ dataset: { title: { type: 'text' } } })
      .mockRejectedValueOnce(new Error('Dataset unavailable'))
      .mockResolvedValueOnce({ dataset: { hero: { type: 'image' } } })

    const result = await listTemplatesWithSchemas()

    expect(result).toHaveLength(3)
    expect(result[0].dataset).toEqual({ title: { type: 'text' } })
    expect(result[1].dataset).toBeNull()
    expect(result[1].error).toBeDefined()
    expect(typeof result[1].error).toBe('string')
    expect(result[2].dataset).toEqual({ hero: { type: 'image' } })
  })

  test('respects limit across pagination: stops fetching after limit reached', async () => {
    const page1 = [
      { id: 't1', title: 'T1' },
      { id: 't2', title: 'T2' },
    ]
    const page2 = [
      { id: 't3', title: 'T3' },
      { id: 't4', title: 'T4' },
    ]
    canvaService.listBrandTemplates
      .mockResolvedValueOnce({ items: page1, continuation: 'next-token' })
      .mockResolvedValueOnce({ items: page2 })
    canvaService.getBrandTemplateDataset.mockResolvedValue({ dataset: {} })

    const result = await listTemplatesWithSchemas({ limit: 3 })

    expect(result).toHaveLength(3)
    expect(canvaService.listBrandTemplates).toHaveBeenCalledTimes(2)
  })
})

// ── previewAutofill ────────────────────────────────────────────────────────────

describe('previewAutofill', () => {
  test('sampleDataPayload has right-typed placeholders for text/image/chart fields', async () => {
    canvaService.listBrandTemplates.mockResolvedValue({
      items: [{ id: 'tmpl-preview', title: 'Preview Template' }],
    })
    canvaService.getBrandTemplateDataset.mockResolvedValue({
      dataset: {
        headline: { type: 'text' },
        hero_image: { type: 'image' },
        sales_data: { type: 'chart' },
        unknown_field: { type: 'custom' },
      },
    })

    const result = await previewAutofill({ templateId: 'tmpl-preview' })

    expect(result.id).toBe('tmpl-preview')
    expect(result.title).toBe('Preview Template')
    expect(result.sampleDataPayload.headline).toMatchObject({ type: 'text', text: 'SAMPLE_TEXT' })
    expect(result.sampleDataPayload.hero_image).toMatchObject({ type: 'image', asset_id: 'REPLACE_ME' })
    expect(result.sampleDataPayload.sales_data).toMatchObject({ type: 'chart' })
    // Unknown types fall back to text placeholder
    expect(result.sampleDataPayload.unknown_field).toMatchObject({ type: 'text', text: 'SAMPLE_TEXT' })
  })

  test('throws 404-status error when template not found', async () => {
    canvaService.listBrandTemplates.mockResolvedValue({ items: [] })
    canvaService.getBrandTemplateDataset.mockResolvedValue({ dataset: {} })

    let thrown
    try {
      await previewAutofill({ templateId: 'nonexistent' })
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeDefined()
    expect(thrown.status).toBe(404)
  })
})
