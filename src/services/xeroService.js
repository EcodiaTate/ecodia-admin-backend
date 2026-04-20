const axios = require('axios')
const db = require('../config/db')
const env = require('../config/env')
const logger = require('../config/logger')
const { encrypt, decrypt } = require('../utils/encryption')
const { createNotification } = require('../db/queries/transactions')
const kgHooks = require('./kgIngestionHooks')

const XERO_TOKEN_URL = 'https://identity.xero.com/connect/token'
const XERO_API_BASE = 'https://api.xero.com/api.xro/2.0'

async function getValidAccessToken() {
  const [token] = await db`SELECT * FROM xero_tokens LIMIT 1`
  if (!token) throw new Error('No Xero tokens found — run OAuth flow first')

  if (new Date(token.expires_at) < new Date(Date.now() + 60_000)) {
    const response = await axios.post(
      XERO_TOKEN_URL,
      new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: decrypt(token.refresh_token),
        client_id: env.XERO_CLIENT_ID,
        client_secret: env.XERO_CLIENT_SECRET,
      }),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    )

    await db`
      UPDATE xero_tokens SET
        access_token = ${encrypt(response.data.access_token)},
        refresh_token = ${encrypt(response.data.refresh_token)},
        expires_at = ${new Date(Date.now() + response.data.expires_in * 1000)},
        updated_at = now()
    `
    return response.data.access_token
  }

  return decrypt(token.access_token)
}

async function exchangeCode(code) {
  const response = await axios.post(
    XERO_TOKEN_URL,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: env.XERO_REDIRECT_URI,
      client_id: env.XERO_CLIENT_ID,
      client_secret: env.XERO_CLIENT_SECRET,
    }),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
  )

  // Upsert token row
  await db`DELETE FROM xero_tokens`
  await db`
    INSERT INTO xero_tokens (access_token, refresh_token, expires_at, tenant_id)
    VALUES (
      ${encrypt(response.data.access_token)},
      ${encrypt(response.data.refresh_token)},
      ${new Date(Date.now() + response.data.expires_in * 1000)},
      ${env.XERO_TENANT_ID}
    )
  `

  logger.info('Xero OAuth tokens stored successfully')
}

function parseXeroDate(xeroDate) {
  const match = xeroDate.match(/\/Date\((\d+)([+-]\d{4})?\)\//)
  if (!match) throw new Error(`Unrecognised Xero date format: ${xeroDate}`)
  return new Date(parseInt(match[1])).toISOString().split('T')[0]
}

async function pollTransactions() {
  const token = await getValidAccessToken()
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

  let response
  try {
    response = await axios.get(
      `${XERO_API_BASE}/BankTransactions?where=Date>DateTime(${since.replace(/-/g, ',')})&order=Date DESC`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'xero-tenant-id': env.XERO_TENANT_ID,
          Accept: 'application/json',
        },
      }
    )
  } catch (err) {
    if (err.response?.status === 403) {
      logger.warn('Xero API returned 403 — resource may be locked. Skipping this poll cycle.')
      return
    }
    throw err
  }

  const deepseekService = require('./deepseekService')

  for (const tx of response.data.BankTransactions) {
    const [existing] = await db`SELECT id, category FROM transactions WHERE xero_id = ${tx.BankTransactionID}`

    if (!existing) {
      const txDate = parseXeroDate(tx.Date)
      const [inserted] = await db`
        INSERT INTO transactions (xero_id, bank_account_id, date, description, amount_aud, type, raw_xero_data)
        VALUES (${tx.BankTransactionID}, ${tx.BankAccount.AccountID},
                ${txDate}, ${tx.Reference || tx.Contact?.Name || 'Unknown'},
                ${tx.Total}, ${tx.Type === 'SPEND' ? 'debit' : 'credit'},
                ${JSON.stringify(tx)})
        RETURNING id
      `

      try {
        const result = await deepseekService.categorize({
          description: tx.Reference || tx.Contact?.Name || 'Unknown',
          amount: tx.Total,
          type: tx.Type === 'SPEND' ? 'debit' : 'credit',
          date: txDate,
        })

        await db`
          UPDATE transactions SET
            category = ${result.category},
            category_confidence = ${result.confidence},
            xero_category = ${result.xeroAccountCode},
            status = 'categorized',
            updated_at = now()
          WHERE id = ${inserted.id}
        `

        // Fire-and-forget KG ingestion
        kgHooks.onTransactionCategorized({
          transaction: {
            description: tx.Reference || tx.Contact?.Name || 'Unknown',
            amount_aud: tx.Total,
            type: tx.Type === 'SPEND' ? 'debit' : 'credit',
            date: txDate,
            category: result.category,
          },
          clientName: tx.Contact?.Name || null,
        }).catch(() => {})

        // Surface low-confidence categorizations to action queue for human review
        if (result.confidence < parseFloat(env.XERO_CATEGORIZATION_CONFIDENCE_MIN || '0.7')) {
          const actionQueue = require('./actionQueueService')
          actionQueue.enqueue({
            source: 'xero',
            sourceRefId: String(inserted.id),
            actionType: 'create_task',
            title: `Review: ${tx.Reference || tx.Contact?.Name || 'Unknown'} ($${Math.abs(tx.Total)})`,
            summary: `Auto-categorized as "${result.category}" with ${(result.confidence * 100).toFixed(0)}% confidence. ${result.notes || ''}`,
            preparedData: {
              title: `Review transaction categorization: ${tx.Reference || tx.Contact?.Name}`,
              description: `Amount: $${Math.abs(tx.Total)} (${tx.Type === 'SPEND' ? 'debit' : 'credit'})\nAuto-category: ${result.category} (${(result.confidence * 100).toFixed(0)}% confidence)\nRationale: ${result.notes}`,
            },
            context: { from: tx.Contact?.Name || null, transactionId: inserted.id, amount: tx.Total, category: result.category },
            resourceKey: `xero:transaction:${inserted.id}`,
            priority: Math.abs(tx.Total) > 500 ? 'high' : 'medium',
          }).catch(() => {})
        }
      } catch (catErr) {
        logger.warn(`Failed to categorize transaction ${inserted.id}`, { error: catErr.message })
      }
    }
  }

  logger.info('Xero poll complete')
}

async function getInvoices({ status, limit = 50 } = {}) {
  const token = await getValidAccessToken()
  const params = [`pageSize=${Math.min(limit, 200)}`, 'order=Date DESC']
  if (status) params.push(`where=Status=="${status}"`)

  const response = await axios.get(
    `${XERO_API_BASE}/Invoices?${params.join('&')}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'xero-tenant-id': env.XERO_TENANT_ID,
        Accept: 'application/json',
      },
    }
  )
  return response.data.Invoices || []
}

async function getContacts({ limit = 50 } = {}) {
  const token = await getValidAccessToken()
  const response = await axios.get(
    `${XERO_API_BASE}/Contacts?pageSize=${Math.min(limit, 200)}&order=Name ASC`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'xero-tenant-id': env.XERO_TENANT_ID,
        Accept: 'application/json',
      },
    }
  )
  return response.data.Contacts || []
}

async function categorizeTransaction(txId, { account_code, category } = {}) {
  const [transaction] = await db`
    UPDATE transactions
    SET
      xero_category = ${account_code},
      ${category ? db`category = ${category},` : db``}
      status = 'categorized',
      updated_at = now()
    WHERE id = ${txId}
    RETURNING *
  `
  return transaction || null
}

module.exports = { getValidAccessToken, exchangeCode, pollTransactions, getInvoices, getContacts, categorizeTransaction }
