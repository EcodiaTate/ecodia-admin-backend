const { google } = require('googleapis')
const crypto = require('crypto')
const env = require('../config/env')
const db = require('../config/db')
const logger = require('../config/logger')
const kgHooks = require('./kgIngestionHooks')

// ═══════════════════════════════════════════════════════════════════════
// GOOGLE DRIVE SERVICE
//
// Syncs all Drive files, extracts content from Docs/Sheets/Slides/PDFs,
// chunks text for embedding, and feeds everything into the KG.
// Runs behind the scenes — you only ever see beauty.
// ═══════════════════════════════════════════════════════════════════════

const DRIVE_ACCOUNTS = [env.GOOGLE_PRIMARY_ACCOUNT]

// Mime types we can extract content from
const EXTRACTABLE_MIMES = {
  'application/vnd.google-apps.document': 'google-doc',
  'application/vnd.google-apps.spreadsheet': 'google-sheet',
  'application/vnd.google-apps.presentation': 'google-slides',
  'application/pdf': 'pdf',
  'text/plain': 'text',
  'text/csv': 'csv',
  'text/markdown': 'markdown',
  'application/json': 'json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
}

// Skip these folders
const SKIP_FOLDERS = new Set(['Trash', '.tmp', 'node_modules'])

// ─── Drive Client ──────────────────────────────────────────────────────

function getDriveClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/documents',
      'https://www.googleapis.com/auth/spreadsheets',
    ],
    subject: userEmail,
  })
  return google.drive({ version: 'v3', auth })
}

function getDocsClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/documents'],
    subject: userEmail,
  })
  return google.docs({ version: 'v1', auth })
}

function getSheetsClient(userEmail) {
  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON)
  const privateKey = credentials.private_key.replace(/\\n/g, '\n')
  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    subject: userEmail,
  })
  return google.sheets({ version: 'v4', auth })
}

// ─── Sync ──────────────────────────────────────────────────────────────

async function pollDrive() {
  for (const account of DRIVE_ACCOUNTS) {
    try {
      const drive = getDriveClient(account)

      const [syncState] = await db`
        SELECT * FROM drive_sync_state WHERE id = ${account}
      `

      if (syncState?.page_token) {
        await incrementalSync(drive, account, syncState.page_token)
      } else {
        await fullSync(drive, account)
      }
    } catch (err) {
      logger.error(`Drive sync failed for ${account}`, { error: err.message })
    }
  }
}

async function fullSync(drive, account) {
  logger.info(`Full Drive sync: ${account}`)

  // Get initial page token for future incremental syncs
  const startTokenRes = await drive.changes.getStartPageToken()
  const startPageToken = startTokenRes.data.startPageToken

  let pageToken = null
  let total = 0

  do {
    const res = await drive.files.list({
      q: "trashed = false",
      fields: 'nextPageToken, files(id, name, mimeType, parents, owners, webViewLink, iconLink, size, createdTime, modifiedTime, lastModifyingUser, shared, trashed)',
      pageSize: 200,
      pageToken,
      orderBy: 'modifiedTime desc',
    })

    const files = res.data.files || []
    for (const file of files) {
      await upsertFile(file, account)
      total++
    }

    pageToken = res.data.nextPageToken
  } while (pageToken)

  // Store page token for incremental sync
  await db`
    INSERT INTO drive_sync_state (id, page_token, last_full_sync_at, updated_at)
    VALUES (${account}, ${startPageToken}, now(), now())
    ON CONFLICT (id) DO UPDATE SET
      page_token = ${startPageToken},
      last_full_sync_at = now(),
      updated_at = now()
  `

  logger.info(`Full Drive sync complete: ${account} (${total} files)`)
}

async function incrementalSync(drive, account, pageToken) {
  try {
    let nextPageToken = pageToken
    let total = 0
    let newToken = null

    do {
      const res = await drive.changes.list({
        pageToken: nextPageToken,
        fields: 'nextPageToken, newStartPageToken, changes(fileId, removed, file(id, name, mimeType, parents, owners, webViewLink, iconLink, size, createdTime, modifiedTime, lastModifyingUser, shared, trashed))',
        pageSize: 100,
      })

      const changes = res.data.changes || []
      for (const change of changes) {
        if (change.removed || change.file?.trashed) {
          await db`
            UPDATE drive_files SET trashed = true, updated_at = now()
            WHERE google_file_id = ${change.fileId}
          `
        } else if (change.file) {
          await upsertFile(change.file, account)
          // Mark content as needing re-extraction if modified
          await db`
            UPDATE drive_files SET content_extracted = false, embedded = false, updated_at = now()
            WHERE google_file_id = ${change.fileId} AND content_extracted = true
          `
        }
        total++
      }

      nextPageToken = res.data.nextPageToken
      newToken = res.data.newStartPageToken
    } while (nextPageToken)

    if (newToken) {
      await db`
        UPDATE drive_sync_state SET
          page_token = ${newToken},
          last_incremental_sync_at = now(),
          updated_at = now()
        WHERE id = ${account}
      `
    }

    if (total > 0) {
      logger.info(`Incremental Drive sync: ${account} (${total} changes)`)
    }
  } catch (err) {
    if (err.code === 403 || err.code === 410) {
      // Token expired or invalid — fall back to full sync
      logger.warn(`Drive page token expired for ${account}, falling back to full sync`)
      await db`UPDATE drive_sync_state SET page_token = null WHERE id = ${account}`
      await fullSync(drive, account)
    } else {
      throw err
    }
  }
}

// ─── File Upsert ───────────────────────────────────────────────────────

async function upsertFile(file, account) {
  const ownerEmail = file.owners?.[0]?.emailAddress || null
  const parentId = file.parents?.[0] || null

  // Resolve parent folder name (cached in DB or fetched)
  let parentFolderName = null
  if (parentId) {
    const [existing] = await db`
      SELECT name FROM drive_files WHERE google_file_id = ${parentId} LIMIT 1
    `
    parentFolderName = existing?.name || null
  }

  const [upserted] = await db`
    INSERT INTO drive_files (
      google_file_id, name, mime_type, parent_folder_id, parent_folder_name,
      owner_email, web_view_link, icon_link, size_bytes,
      created_time, modified_time, last_modifying_user, shared, trashed,
      source_account, raw_data
    ) VALUES (
      ${file.id}, ${file.name}, ${file.mimeType}, ${parentId}, ${parentFolderName},
      ${ownerEmail}, ${file.webViewLink || null}, ${file.iconLink || null},
      ${file.size ? parseInt(file.size) : null},
      ${file.createdTime || null}, ${file.modifiedTime || null},
      ${file.lastModifyingUser?.displayName || null},
      ${file.shared || false}, ${file.trashed || false},
      ${account}, ${JSON.stringify(file)}
    )
    ON CONFLICT (google_file_id) DO UPDATE SET
      name = EXCLUDED.name,
      mime_type = EXCLUDED.mime_type,
      parent_folder_id = EXCLUDED.parent_folder_id,
      parent_folder_name = EXCLUDED.parent_folder_name,
      modified_time = EXCLUDED.modified_time,
      last_modifying_user = EXCLUDED.last_modifying_user,
      shared = EXCLUDED.shared,
      trashed = EXCLUDED.trashed,
      raw_data = EXCLUDED.raw_data,
      updated_at = now()
    RETURNING *
  `

  return upserted
}

// ─── Content Extraction ────────────────────────────────────────────────

async function extractContent(batchSize = 20) {
  // Get files needing content extraction
  const files = await db`
    SELECT * FROM drive_files
    WHERE content_extracted = false
      AND trashed = false
      AND mime_type = ANY(${Object.keys(EXTRACTABLE_MIMES)})
    ORDER BY modified_time DESC
    LIMIT ${batchSize}
  `

  let extracted = 0
  for (const file of files) {
    try {
      const text = await extractFileContent(file)
      if (text) {
        const hash = crypto.createHash('sha256').update(text).digest('hex')

        // Skip if content hasn't changed
        if (hash === file.content_hash) {
          await db`UPDATE drive_files SET content_extracted = true WHERE id = ${file.id}`
          continue
        }

        await db`
          UPDATE drive_files SET
            content_text = ${text.slice(0, 100000)},
            content_hash = ${hash},
            content_extracted = true,
            embedded = false,
            updated_at = now()
          WHERE id = ${file.id}
        `

        // Fire KG hook
        kgHooks.onDriveFileProcessed({
          file: { ...file, content_text: text },
        }).catch(() => {})

        extracted++
      } else {
        // Mark as extracted even if empty so we don't retry
        await db`UPDATE drive_files SET content_extracted = true WHERE id = ${file.id}`
      }
    } catch (err) {
      logger.debug(`Content extraction failed for ${file.name}`, { error: err.message })
      // Mark as extracted to avoid infinite retries — will retry on next modification
      await db`UPDATE drive_files SET content_extracted = true WHERE id = ${file.id}`
    }
  }

  if (extracted > 0) {
    logger.info(`Drive content extraction: ${extracted}/${files.length} files`)
  }
  return extracted
}

async function extractFileContent(file) {
  const account = file.source_account
  const type = EXTRACTABLE_MIMES[file.mime_type]

  switch (type) {
    case 'google-doc':
      return extractGoogleDoc(account, file.google_file_id)
    case 'google-sheet':
      return extractGoogleSheet(account, file.google_file_id)
    case 'google-slides':
      return extractGoogleSlides(account, file.google_file_id)
    case 'pdf':
    case 'docx':
    case 'xlsx':
      return exportAndExtract(account, file.google_file_id, file.mime_type)
    case 'text':
    case 'csv':
    case 'markdown':
    case 'json':
      return downloadPlaintext(account, file.google_file_id)
    default:
      return null
  }
}

async function extractGoogleDoc(account, fileId) {
  const docs = getDocsClient(account)
  const res = await docs.documents.get({ documentId: fileId })

  // Walk the document body and extract all text
  const content = res.data.body?.content || []
  const parts = []

  for (const element of content) {
    if (element.paragraph) {
      const text = element.paragraph.elements
        ?.map(e => e.textRun?.content || '')
        .join('') || ''
      parts.push(text)
    } else if (element.table) {
      // Extract table content row by row
      for (const row of element.table.tableRows || []) {
        const cells = (row.tableCells || []).map(cell => {
          return (cell.content || [])
            .map(c => c.paragraph?.elements?.map(e => e.textRun?.content || '').join('') || '')
            .join(' ')
        })
        parts.push(cells.join(' | '))
      }
    }
  }

  return parts.join('\n').trim()
}

async function extractGoogleSheet(account, fileId) {
  const sheets = getSheetsClient(account)
  const res = await sheets.spreadsheets.get({
    spreadsheetId: fileId,
    includeGridData: false,
  })

  const sheetNames = (res.data.sheets || []).map(s => s.properties.title)
  const parts = []

  // Read first 5 sheets, max 500 rows each
  for (const sheetName of sheetNames.slice(0, 5)) {
    try {
      const dataRes = await sheets.spreadsheets.values.get({
        spreadsheetId: fileId,
        range: `'${sheetName}'!A1:Z500`,
      })

      const rows = dataRes.data.values || []
      if (rows.length === 0) continue

      parts.push(`## Sheet: ${sheetName}`)

      // Header row
      if (rows[0]) {
        parts.push(rows[0].join(' | '))
        parts.push(rows[0].map(() => '---').join(' | '))
      }

      // Data rows
      for (const row of rows.slice(1)) {
        parts.push(row.join(' | '))
      }
      parts.push('')
    } catch (err) {
      logger.debug(`Failed to read sheet ${sheetName} from ${fileId}`, { error: err.message })
    }
  }

  return parts.join('\n').trim()
}

async function extractGoogleSlides(account, fileId) {
  // Export slides as plain text via Drive export
  const drive = getDriveClient(account)
  try {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    }, { responseType: 'text' })
    return typeof res.data === 'string' ? res.data : JSON.stringify(res.data)
  } catch {
    return null
  }
}

async function exportAndExtract(account, fileId, mimeType) {
  const drive = getDriveClient(account)

  // For native Google formats or importable formats, export as text
  if (mimeType === 'application/pdf') {
    // PDFs can't be easily extracted server-side without extra deps
    // Store metadata only, mark for future extraction if needed
    return null
  }

  // For Office formats, try Drive's export to plain text
  try {
    const res = await drive.files.export({
      fileId,
      mimeType: 'text/plain',
    }, { responseType: 'text' })
    return typeof res.data === 'string' ? res.data : null
  } catch {
    // If export fails (e.g., not a Google format), download directly
    return downloadPlaintext(account, fileId)
  }
}

async function downloadPlaintext(account, fileId) {
  const drive = getDriveClient(account)
  try {
    const res = await drive.files.get({
      fileId,
      alt: 'media',
    }, { responseType: 'text' })
    return typeof res.data === 'string' ? res.data.slice(0, 100000) : null
  } catch {
    return null
  }
}

// ─── Embed Extracted Content ───────────────────────────────────────────

async function embedStaleFiles(batchSize = 20) {
  const files = await db`
    SELECT id, name, content_text, mime_type FROM drive_files
    WHERE embedded = false AND content_text IS NOT NULL AND trashed = false
    LIMIT ${batchSize}
  `

  if (files.length === 0) return 0

  // Chunk large documents and embed via KG service
  const kg = require('./knowledgeGraphService')

  for (const file of files) {
    try {
      const text = file.content_text
      const chunks = chunkText(text, 800)

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]
        await kg.ensureNode({
          label: 'Document',
          name: `${file.name}${chunks.length > 1 ? ` (part ${i + 1})` : ''}`,
          properties: {
            source: 'google_drive',
            mime_type: file.mime_type,
            chunk_index: i,
            total_chunks: chunks.length,
            content_preview: chunk.slice(0, 500),
          },
          sourceModule: 'google_drive',
          sourceId: file.id,
        })
      }

      await db`UPDATE drive_files SET embedded = true, updated_at = now() WHERE id = ${file.id}`
    } catch (err) {
      logger.debug(`Failed to embed Drive file ${file.name}`, { error: err.message })
    }
  }

  logger.info(`Drive embedding: ${files.length} files`)
  return files.length
}

function chunkText(text, targetTokens) {
  // Rough: 1 token ≈ 4 chars
  const targetChars = targetTokens * 4
  if (text.length <= targetChars) return [text]

  const chunks = []
  const paragraphs = text.split(/\n\n+/)
  let current = ''

  for (const para of paragraphs) {
    if (current.length + para.length > targetChars && current.length > 0) {
      chunks.push(current.trim())
      current = ''
    }
    current += para + '\n\n'
  }
  if (current.trim()) chunks.push(current.trim())

  return chunks
}

// ─── Query ─────────────────────────────────────────────────────────────

async function searchFiles(query, { limit = 20 } = {}) {
  const files = await db`
    SELECT id, name, mime_type, parent_folder_name, web_view_link,
           modified_time, last_modifying_user, owner_email,
           content_text IS NOT NULL AS has_content
    FROM drive_files
    WHERE trashed = false
      AND (name ILIKE ${'%' + query + '%'}
           OR content_text ILIKE ${'%' + query + '%'})
    ORDER BY modified_time DESC
    LIMIT ${limit}
  `
  return files
}

async function getStats() {
  const [stats] = await db`
    SELECT
      count(*)::int AS total_files,
      count(*) FILTER (WHERE content_extracted AND content_text IS NOT NULL)::int AS with_content,
      count(*) FILTER (WHERE embedded)::int AS embedded,
      count(*) FILTER (WHERE mime_type LIKE 'application/vnd.google-apps.document%')::int AS docs,
      count(*) FILTER (WHERE mime_type LIKE 'application/vnd.google-apps.spreadsheet%')::int AS sheets,
      count(*) FILTER (WHERE mime_type LIKE 'application/vnd.google-apps.presentation%')::int AS slides,
      count(*) FILTER (WHERE mime_type = 'application/pdf')::int AS pdfs,
      max(modified_time) AS last_modified
    FROM drive_files
    WHERE trashed = false
  `
  return stats
}

async function getFolderTree() {
  const folders = await db`
    SELECT google_file_id, name, parent_folder_id
    FROM drive_files
    WHERE mime_type = 'application/vnd.google-apps.folder' AND trashed = false
    ORDER BY name
  `

  // Build tree
  const map = new Map()
  for (const f of folders) {
    map.set(f.google_file_id, { name: f.name, parentId: f.parent_folder_id, children: [] })
  }
  const roots = []
  for (const [id, node] of map) {
    if (node.parentId && map.has(node.parentId)) {
      map.get(node.parentId).children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

// ─── Write Operations ──────────────────────────────────────────────────

async function createDocument(account, { title, content, folderId }) {
  const docs = getDocsClient(account)
  const drive = getDriveClient(account)

  // Create empty doc
  const doc = await docs.documents.create({
    requestBody: { title },
  })

  // Move to folder if specified
  if (folderId) {
    await drive.files.update({
      fileId: doc.data.documentId,
      addParents: folderId,
      fields: 'id, parents',
    })
  }

  // Insert content if provided
  if (content) {
    await docs.documents.batchUpdate({
      documentId: doc.data.documentId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: 1 },
            text: content,
          },
        }],
      },
    })
  }

  logger.info(`Created Google Doc: ${title} (${doc.data.documentId})`)
  return { documentId: doc.data.documentId, title }
}

async function appendToDocument(account, documentId, content) {
  const docs = getDocsClient(account)

  // Get current doc length to append at end
  const doc = await docs.documents.get({ documentId })
  const endIndex = doc.data.body.content.slice(-1)[0]?.endIndex || 1

  await docs.documents.batchUpdate({
    documentId,
    requestBody: {
      requests: [{
        insertText: {
          location: { index: Math.max(1, endIndex - 1) },
          text: '\n' + content,
        },
      }],
    },
  })

  return { documentId, appended: content.length }
}

async function createSpreadsheet(account, { title, sheets, folderId }) {
  const sheetsClient = getSheetsClient(account)
  const drive = getDriveClient(account)

  const requestBody = {
    properties: { title },
    sheets: (sheets || [{ properties: { title: 'Sheet1' } }]).map(s => ({
      properties: { title: s.title || s.properties?.title || 'Sheet1' },
    })),
  }

  const res = await sheetsClient.spreadsheets.create({ requestBody })

  if (folderId) {
    await drive.files.update({
      fileId: res.data.spreadsheetId,
      addParents: folderId,
      fields: 'id, parents',
    })
  }

  logger.info(`Created Google Sheet: ${title} (${res.data.spreadsheetId})`)
  return { spreadsheetId: res.data.spreadsheetId, title }
}

async function writeToSheet(account, spreadsheetId, { range, values }) {
  const sheets = getSheetsClient(account)

  const res = await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  })

  return { updatedCells: res.data.updatedCells, updatedRange: res.data.updatedRange }
}

async function appendToSheet(account, spreadsheetId, { range, values }) {
  const sheets = getSheetsClient(account)

  const res = await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values },
  })

  return { updatedCells: res.data.updates?.updatedCells, updatedRange: res.data.updates?.updatedRange }
}

async function uploadFile(account, { name, mimeType, content, folderId }) {
  const drive = getDriveClient(account)
  const { Readable } = require('stream')

  const fileMetadata = { name }
  if (folderId) fileMetadata.parents = [folderId]

  const media = {
    mimeType: mimeType || 'text/plain',
    body: Readable.from(Buffer.from(content)),
  }

  const res = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink',
  })

  logger.info(`Uploaded file to Drive: ${name} (${res.data.id})`)
  return res.data
}

async function moveFile(account, fileId, newFolderId) {
  const drive = getDriveClient(account)

  // Get current parents
  const file = await drive.files.get({ fileId, fields: 'parents' })
  const previousParents = (file.data.parents || []).join(',')

  const res = await drive.files.update({
    fileId,
    addParents: newFolderId,
    removeParents: previousParents,
    fields: 'id, name, parents',
  })

  return res.data
}

async function renameFile(account, fileId, newName) {
  const drive = getDriveClient(account)
  const res = await drive.files.update({
    fileId,
    requestBody: { name: newName },
    fields: 'id, name',
  })
  return res.data
}

async function createFolder(account, { name, parentFolderId }) {
  const drive = getDriveClient(account)

  const fileMetadata = {
    name,
    mimeType: 'application/vnd.google-apps.folder',
  }
  if (parentFolderId) fileMetadata.parents = [parentFolderId]

  const res = await drive.files.create({
    requestBody: fileMetadata,
    fields: 'id, name, webViewLink',
  })

  logger.info(`Created Drive folder: ${name} (${res.data.id})`)
  return res.data
}

async function deleteFile(account, fileId) {
  const drive = getDriveClient(account)
  await drive.files.delete({ fileId })
  await db`UPDATE drive_files SET trashed = true, updated_at = now() WHERE google_file_id = ${fileId}`
}

async function shareFile(account, fileId, { email, role = 'reader', type = 'user' }) {
  const drive = getDriveClient(account)
  const res = await drive.permissions.create({
    fileId,
    requestBody: { role, type, emailAddress: email },
    sendNotificationEmail: true,
  })
  return res.data
}

module.exports = {
  pollDrive,
  extractContent,
  embedStaleFiles,
  searchFiles,
  getStats,
  getFolderTree,
  getDriveClient,
  getDocsClient,
  getSheetsClient,
  // Write operations
  createDocument,
  appendToDocument,
  createSpreadsheet,
  writeToSheet,
  appendToSheet,
  uploadFile,
  moveFile,
  renameFile,
  createFolder,
  deleteFile,
  shareFile,
}
