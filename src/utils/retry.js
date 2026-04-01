const logger = require('../config/logger')

async function retry(fn, { attempts = 3, delayMs = 1000, backoff = 2, label = 'operation' } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i === attempts - 1) throw err
      const wait = delayMs * Math.pow(backoff, i)
      logger.warn(`${label} failed (attempt ${i + 1}/${attempts}), retrying in ${wait}ms`, {
        error: err.message,
      })
      await new Promise(r => setTimeout(r, wait))
    }
  }
}

module.exports = retry
