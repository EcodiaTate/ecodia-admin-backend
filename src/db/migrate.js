require('../config/env')
const fs = require('fs')
const path = require('path')
const db = require('../config/db')
const logger = require('../config/logger')

async function migrate() {
  // Ensure _migrations table exists
  await db`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`

  const migrationsDir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const applied = await db`SELECT filename FROM _migrations`
  const appliedSet = new Set(applied.map(r => r.filename))

  for (const file of files) {
    if (appliedSet.has(file)) {
      logger.info(`Skipping ${file} (already applied)`)
      continue
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    logger.info(`Applying migration: ${file}`)

    await db.begin(async tx => {
      await tx.unsafe(sql)
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`
    })

    logger.info(`Applied: ${file}`)
  }

  logger.info('All migrations applied')
  await db.end()
}

migrate().catch(err => {
  logger.error('Migration failed', { error: err.message, stack: err.stack })
  process.exit(1)
})
