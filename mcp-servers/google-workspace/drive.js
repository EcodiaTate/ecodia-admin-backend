/**
 * Google Drive MCP tools — search, read, create docs/sheets.
 */
import { z } from 'zod'
import { getDriveClient, primaryAccount } from './auth.js'

export function registerDriveTools(server) {

  server.tool('drive_search',
    'Search Google Drive for files.',
    { query: z.string().optional().describe('Drive API query (e.g. "name contains \'report\'")'), maxResults: z.number().default(20), account: z.string().optional() },
    async ({ query, maxResults, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      const params = { pageSize: Math.min(maxResults, 50), fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink,parents)', orderBy: 'modifiedTime desc' }
      if (query) params.q = query
      const res = await drive.files.list(params)
      return { content: [{ type: 'text', text: JSON.stringify(res.data.files || [], null, 2) }] }
    }
  )

  server.tool('drive_get_file',
    'Get metadata and content of a Drive file. For Docs/Sheets, returns document content.',
    { fileId: z.string(), account: z.string().optional() },
    async ({ fileId, account }) => {
      const { drive, docs, sheets } = getDriveClient(account || primaryAccount)
      const meta = await drive.files.get({ fileId, fields: 'id,name,mimeType,modifiedTime,size,webViewLink' })
      const file = meta.data
      if (file.mimeType === 'application/vnd.google-apps.document') {
        const doc = await docs.documents.get({ documentId: fileId })
        const text = doc.data.body?.content?.filter(e => e.paragraph).map(e => e.paragraph.elements?.map(el => el.textRun?.content || '').join('')).join('') || ''
        return { content: [{ type: 'text', text: JSON.stringify({ ...file, content: text.slice(0, 20000) }, null, 2) }] }
      }
      if (file.mimeType === 'application/vnd.google-apps.spreadsheet') {
        const sheet = await sheets.spreadsheets.get({ spreadsheetId: fileId, includeGridData: false })
        const sheetNames = sheet.data.sheets?.map(s => s.properties?.title) || []
        return { content: [{ type: 'text', text: JSON.stringify({ ...file, sheets: sheetNames }, null, 2) }] }
      }
      return { content: [{ type: 'text', text: JSON.stringify(file, null, 2) }] }
    }
  )

  server.tool('drive_create_doc',
    'Create a new Google Doc.',
    { title: z.string(), content: z.string().optional().describe('Initial text content'), folderId: z.string().optional(), account: z.string().optional() },
    async ({ title, content, folderId, account }) => {
      const { docs, drive } = getDriveClient(account || primaryAccount)
      const doc = await docs.documents.create({ requestBody: { title } })
      const docId = doc.data.documentId
      if (content) {
        await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] } })
      }
      if (folderId) {
        const file = await drive.files.get({ fileId: docId, fields: 'parents' })
        await drive.files.update({ fileId: docId, addParents: folderId, removeParents: file.data.parents?.join(',') })
      }
      return { content: [{ type: 'text', text: `Doc created: https://docs.google.com/document/d/${docId}` }] }
    }
  )

  server.tool('drive_read_sheet',
    'Read data from a Google Sheet.',
    { spreadsheetId: z.string(), range: z.string().optional().describe('A1 notation (e.g. "Sheet1!A1:D10"). Default: first sheet'), account: z.string().optional() },
    async ({ spreadsheetId, range, account }) => {
      const { sheets } = getDriveClient(account || primaryAccount)
      if (!range) {
        const meta = await sheets.spreadsheets.get({ spreadsheetId, includeGridData: false })
        range = meta.data.sheets?.[0]?.properties?.title || 'Sheet1'
      }
      const res = await sheets.spreadsheets.values.get({ spreadsheetId, range })
      return { content: [{ type: 'text', text: JSON.stringify(res.data.values || [], null, 2) }] }
    }
  )

  server.tool('drive_update_sheet',
    'Write data to a Google Sheet.',
    { spreadsheetId: z.string(), range: z.string().describe('A1 notation range to write to'), values: z.array(z.array(z.string())).describe('2D array of values'), account: z.string().optional() },
    async ({ spreadsheetId, range, values, account }) => {
      const { sheets } = getDriveClient(account || primaryAccount)
      const res = await sheets.spreadsheets.values.update({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', requestBody: { values } })
      return { content: [{ type: 'text', text: `Updated ${res.data.updatedCells} cells in ${range}` }] }
    }
  )
}
