require('../config/env')
const fs = require('fs')
const path = require('path')
const postgres = require('postgres')
const env = require('../config/env')
const logger = require('../config/logger')

// Use a single connection for migrations — avoids pool exhaustion
// when the main app is running and holding connections
const db = postgres(env.DATABASE_URL, {
  max: 1,
  idle_timeout: 60,    // was 10s — too short for slow Supabase pooled connections
  connect_timeout: 30,
})

async function migrate() {
  // Ensure _migrations table exists
  await db`CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ DEFAULT now())`

  const migrationsDir = path.join(__dirname, 'migrations')
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort()

  const applied = await db`SELECT filename FROM _migrations`
  const appliedSet = new Set(applied.map(r => r.filename))

  let skipped = 0
  let newlyApplied = 0

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped++
      logger.debug(`Skipping ${file} (already applied)`)
      continue
    }

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8')
    logger.info(`Applying migration: ${file}`)

    await db.begin(async tx => {
      await tx.unsafe(sql)
      await tx`INSERT INTO _migrations (filename) VALUES (${file})`
    })

    newlyApplied++
    logger.info(`Applied: ${file}`)
  }

  logger.info(`Migrations complete — ${newlyApplied} applied, ${skipped} already up to date`)
  await db.end()
}

migrate().catch(err => {
  logger.error('Migration failed', { error: err.message, stack: err.stack })
  process.exit(1)
})
