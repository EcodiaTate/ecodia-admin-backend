/**
 * Google Drive + Docs + Sheets MCP tools — full CRUD.
 */
import { z } from 'zod'
import { getDriveClient, primaryAccount } from './auth.js'

export function registerDriveTools(server) {

  // ── Drive: files & folders ──

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

  server.tool('drive_list_folder',
    'List files in a specific Drive folder.',
    { folderId: z.string().describe('Folder ID (use "root" for top-level)'), maxResults: z.number().default(30), account: z.string().optional() },
    async ({ folderId, maxResults, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      const res = await drive.files.list({ q: `'${folderId}' in parents and trashed = false`, pageSize: Math.min(maxResults, 100), fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)', orderBy: 'folder,name' })
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

  server.tool('drive_create_folder',
    'Create a new folder in Google Drive.',
    { name: z.string(), parentId: z.string().optional().describe('Parent folder ID'), account: z.string().optional() },
    async ({ name, parentId, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      const res = await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder', parents: parentId ? [parentId] : undefined }, fields: 'id,name,webViewLink' })
      return { content: [{ type: 'text', text: `Folder created: ${res.data.name} (${res.data.webViewLink})` }] }
    }
  )

  server.tool('drive_move_file',
    'Move a file to a different folder.',
    { fileId: z.string(), newParentId: z.string().describe('Destination folder ID'), account: z.string().optional() },
    async ({ fileId, newParentId, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      const file = await drive.files.get({ fileId, fields: 'parents' })
      await drive.files.update({ fileId, addParents: newParentId, removeParents: file.data.parents?.join(','), fields: 'id,name,parents' })
      return { content: [{ type: 'text', text: `File ${fileId} moved to folder ${newParentId}` }] }
    }
  )

  server.tool('drive_delete_file',
    'Move a file to trash.',
    { fileId: z.string(), account: z.string().optional() },
    async ({ fileId, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      await drive.files.update({ fileId, requestBody: { trashed: true } })
      return { content: [{ type: 'text', text: `File ${fileId} trashed.` }] }
    }
  )

  server.tool('drive_share_file',
    'Share a file or folder with someone.',
    { fileId: z.string(), email: z.string().describe('Email to share with'), role: z.enum(['reader', 'commenter', 'writer', 'owner']).default('reader'), account: z.string().optional() },
    async ({ fileId, email, role, account }) => {
      const { drive } = getDriveClient(account || primaryAccount)
      await drive.permissions.create({ fileId, requestBody: { type: 'user', role, emailAddress: email }, sendNotificationEmail: true })
      return { content: [{ type: 'text', text: `Shared ${fileId} with ${email} as ${role}` }] }
    }
  )

  // ── Google Docs ──

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

  server.tool('drive_update_doc',
    'Append or replace content in an existing Google Doc.',
    { documentId: z.string(), content: z.string().describe('Text to append'), replace: z.boolean().default(false).describe('If true, replaces all content. If false, appends.'), account: z.string().optional() },
    async ({ documentId, content, replace, account }) => {
      const { docs } = getDriveClient(account || primaryAccount)
      if (replace) {
        const doc = await docs.documents.get({ documentId })
        const endIndex = doc.data.body?.content?.slice(-1)?.[0]?.endIndex || 1
        const requests = []
        if (endIndex > 2) {
          requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } })
        }
        requests.push({ insertText: { location: { index: 1 }, text: content } })
        await docs.documents.batchUpdate({ documentId, requestBody: { requests } })
      } else {
        const doc = await docs.documents.get({ documentId })
        const endIndex = doc.data.body?.content?.slice(-1)?.[0]?.endIndex || 1
        await docs.documents.batchUpdate({ documentId, requestBody: { requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text: '\n' + content } }] } })
      }
      return { content: [{ type: 'text', text: `Doc ${documentId} ${replace ? 'replaced' : 'updated'}. https://docs.google.com/document/d/${documentId}` }] }
    }
  )

  // ── Google Sheets ──

  server.tool('drive_create_sheet',
    'Create a new Google Spreadsheet.',
    { title: z.string(), sheetNames: z.array(z.string()).optional().describe('Sheet tab names (default: ["Sheet1"])'), folderId: z.string().optional(), account: z.string().optional() },
    async ({ title, sheetNames, folderId, account }) => {
      const { sheets, drive } = getDriveClient(account || primaryAccount)
      const sheetProps = (sheetNames || ['Sheet1']).map(name => ({ properties: { title: name } }))
      const res = await sheets.spreadsheets.create({ requestBody: { properties: { title }, sheets: sheetProps } })
      const ssId = res.data.spreadsheetId
      if (folderId) {
        const file = await drive.files.get({ fileId: ssId, fields: 'parents' })
        await drive.files.update({ fileId: ssId, addParents: folderId, removeParents: file.data.parents?.join(',') })
      }
      return { content: [{ type: 'text', text: `Spreadsheet created: https://docs.google.com/spreadsheets/d/${ssId}` }] }
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

  server.tool('drive_append_sheet',
    'Append rows to the end of a Google Sheet.',
    { spreadsheetId: z.string(), range: z.string().default('Sheet1').describe('Sheet name or range to append to'), values: z.array(z.array(z.string())).describe('Rows to append (2D array)'), account: z.string().optional() },
    async ({ spreadsheetId, range, values, account }) => {
      const { sheets } = getDriveClient(account || primaryAccount)
      const res = await sheets.spreadsheets.values.append({ spreadsheetId, range, valueInputOption: 'USER_ENTERED', insertDataOption: 'INSERT_ROWS', requestBody: { values } })
      return { content: [{ type: 'text', text: `Appended ${res.data.updates?.updatedRows || values.length} rows to ${range}` }] }
    }
  )
}
