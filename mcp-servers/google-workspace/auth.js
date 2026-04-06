/**
 * Shared Google auth — JWT with Domain-Wide Delegation.
 * Replicates the pattern from backend/src/services/gmailService.js
 */
import { google } from 'googleapis'

const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}'
const PRIMARY_ACCOUNT = process.env.GOOGLE_PRIMARY_ACCOUNT || ''

let _credentials = null
function getCredentials() {
  if (!_credentials) {
    _credentials = JSON.parse(SERVICE_ACCOUNT_JSON)
    _credentials._privateKey = _credentials.private_key?.replace(/\\n/g, '\n')
  }
  return _credentials
}

export function createAuth(scopes, userEmail) {
  const creds = getCredentials()
  return new google.auth.JWT({
    email: creds.client_email,
    key: creds._privateKey,
    scopes,
    subject: userEmail || PRIMARY_ACCOUNT,
  })
}

export function getGmailClient(userEmail) {
  const auth = createAuth([
    'https://www.googleapis.com/auth/gmail.modify',
    'https://www.googleapis.com/auth/gmail.compose',
  ], userEmail)
  return google.gmail({ version: 'v1', auth })
}

export function getCalendarClient(userEmail) {
  const auth = createAuth([
    'https://www.googleapis.com/auth/calendar',
  ], userEmail)
  return google.calendar({ version: 'v3', auth })
}

export function getDriveClient(userEmail) {
  const auth = createAuth([
    'https://www.googleapis.com/auth/drive',
    'https://www.googleapis.com/auth/documents',
    'https://www.googleapis.com/auth/spreadsheets',
  ], userEmail)
  return {
    drive: google.drive({ version: 'v3', auth }),
    docs: google.docs({ version: 'v1', auth }),
    sheets: google.sheets({ version: 'v4', auth }),
  }
}

export const primaryAccount = PRIMARY_ACCOUNT
