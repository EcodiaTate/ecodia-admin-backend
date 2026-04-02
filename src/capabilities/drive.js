const registry = require('../services/capabilityRegistry')
const env = require('../config/env')

registry.registerMany([
  {
    name: 'create_doc',
    description: 'Create a new Google Doc with optional initial content',
    tier: 'write',
    domain: 'drive',
    params: {
      title: { type: 'string', required: true, description: 'Document title' },
      content: { type: 'string', required: false, description: 'Initial document text' },
      folderId: { type: 'string', required: false, description: 'Parent folder ID' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      const doc = await drive.createDocument(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params)
      return { message: `Document created: ${params.title}`, documentId: doc.documentId }
    },
  },
  {
    name: 'append_to_doc',
    description: 'Append text to an existing Google Doc',
    tier: 'write',
    domain: 'drive',
    params: {
      documentId: { type: 'string', required: true, description: 'Google Doc ID' },
      content: { type: 'string', required: true, description: 'Text to append' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      await drive.appendToDocument(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params.documentId, params.content)
      return { message: `Appended to document ${params.documentId}` }
    },
  },
  {
    name: 'create_sheet',
    description: 'Create a new Google Spreadsheet',
    tier: 'write',
    domain: 'drive',
    params: {
      title: { type: 'string', required: true, description: 'Spreadsheet title' },
      sheets: { type: 'array', required: false, description: 'Sheet tab configs [{title}]' },
      folderId: { type: 'string', required: false, description: 'Parent folder ID' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      const sheet = await drive.createSpreadsheet(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params)
      return { message: `Spreadsheet created: ${params.title}`, spreadsheetId: sheet.spreadsheetId }
    },
  },
  {
    name: 'write_sheet',
    description: 'Write data to a range in a Google Spreadsheet',
    tier: 'write',
    domain: 'drive',
    params: {
      spreadsheetId: { type: 'string', required: true, description: 'Spreadsheet ID' },
      range: { type: 'string', required: true, description: 'A1 notation range e.g. Sheet1!A1:D10' },
      values: { type: 'array', required: true, description: 'Array of rows, each an array of values' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      await drive.writeToSheet(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params.spreadsheetId, { range: params.range, values: params.values })
      return { message: `Written to ${params.range}` }
    },
  },
  {
    name: 'create_folder',
    description: 'Create a folder in Google Drive',
    tier: 'write',
    domain: 'drive',
    params: {
      name: { type: 'string', required: true, description: 'Folder name' },
      parentFolderId: { type: 'string', required: false, description: 'Parent folder ID' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      const folder = await drive.createFolder(params.account || env.GOOGLE_PRIMARY_ACCOUNT, { name: params.name, parentFolderId: params.parentFolderId })
      return { message: `Folder created: ${params.name}`, folderId: folder.id }
    },
  },
  {
    name: 'move_file',
    description: 'Move a file to a different folder in Google Drive',
    tier: 'write',
    domain: 'drive',
    params: {
      fileId: { type: 'string', required: true, description: 'File ID to move' },
      folderId: { type: 'string', required: true, description: 'Destination folder ID' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      await drive.moveFile(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params.fileId, params.folderId)
      return { message: `File moved to folder ${params.folderId}` }
    },
  },
  {
    name: 'share_file',
    description: 'Share a Google Drive file with a user',
    tier: 'write',
    domain: 'drive',
    params: {
      fileId: { type: 'string', required: true, description: 'File ID to share' },
      email: { type: 'string', required: true, description: 'Email to share with' },
      role: { type: 'string', required: false, description: 'Permission role: reader, writer, owner' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      await drive.shareFile(params.account || env.GOOGLE_PRIMARY_ACCOUNT, params.fileId, { email: params.email, role: params.role || 'reader' })
      return { message: `File shared with ${params.email}` }
    },
  },
  {
    name: 'search_drive',
    description: 'Search Google Drive for files by name or content',
    tier: 'read',
    domain: 'drive',
    params: {
      query: { type: 'string', required: true, description: 'Search query' },
      limit: { type: 'number', required: false, description: 'Max results (default 10)' },
    },
    handler: async (params) => {
      const drive = require('../services/googleDriveService')
      return drive.searchFiles(params.query, { limit: params.limit || 10 })
    },
  },
])
