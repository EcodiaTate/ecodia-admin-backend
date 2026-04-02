const registry = require('../services/capabilityRegistry')

registry.registerMany([
  {
    name: 'sync_xero',
    description: 'Trigger a Xero sync to pull latest transactions and financial data',
    tier: 'write',
    domain: 'finance',
    params: {},
    handler: async () => {
      const xero = require('../services/xeroService')
      await xero.pollTransactions()
      return { message: 'Xero sync complete' }
    },
  },
  {
    name: 'categorize_transaction',
    description: 'Categorize an uncategorized Xero transaction using AI classification',
    tier: 'write',
    domain: 'finance',
    params: {
      transactionId: { type: 'string', required: true, description: 'Transaction UUID' },
      category: { type: 'string', required: false, description: 'Category name (AI selects if omitted)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      let category = params.category

      if (!category) {
        // deepseek.categorize expects { description, amount, type, date }
        // and returns { category, confidence, xeroAccountCode, notes } — extract .category
        const [tx] = await db`
          SELECT description, amount_aud AS amount, type, date
          FROM transactions WHERE id = ${params.transactionId}
        `
        if (!tx) throw new Error(`Transaction ${params.transactionId} not found`)
        const deepseek = require('../services/deepseekService')
        const result = await deepseek.categorize({
          description: tx.description,
          amount: tx.amount,
          type: tx.type,
          date: tx.date,
        })
        category = result?.category || result
        if (typeof category !== 'string') throw new Error(`categorize returned unexpected shape: ${JSON.stringify(result)}`)
      }

      await db`
        UPDATE transactions
        SET category = ${category}, status = 'categorized', updated_at = now()
        WHERE id = ${params.transactionId}
      `
      return { message: `Transaction categorized as: ${category}`, category }
    },
  },
  {
    name: 'categorize_all_pending',
    description: 'AI-categorize all currently uncategorized transactions in bulk',
    tier: 'write',
    domain: 'finance',
    params: {
      limit: { type: 'number', required: false, description: 'Max transactions to process (default 50)' },
    },
    handler: async (params) => {
      const db = require('../config/db')
      const deepseek = require('../services/deepseekService')
      const uncategorized = await db`
        SELECT id, description, amount_aud AS amount, type, date
        FROM transactions WHERE status = 'uncategorized'
        ORDER BY date DESC LIMIT ${params.limit || 50}
      `

      let categorized = 0
      for (const tx of uncategorized) {
        try {
          const result = await deepseek.categorize({
            description: tx.description,
            amount: tx.amount,
            type: tx.type,
            date: tx.date,
          })
          const category = result?.category || result
          if (typeof category !== 'string') continue
          await db`
            UPDATE transactions
            SET category = ${category}, status = 'categorized', updated_at = now()
            WHERE id = ${tx.id}
          `
          categorized++
        } catch {
          // continue — don't let one failure stop the batch
        }
      }

      return { message: `Categorized ${categorized} of ${uncategorized.length} transactions`, categorized }
    },
  },
])
