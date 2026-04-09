require('../config/env')
const db = require('../config/db')
const kg = require('../services/knowledgeGraphService')
const kgHooks = require('../services/kgIngestionHooks')
const logger = require('../config/logger')

async function backfill() {
  logger.info('Starting KG backfill...')

  // Ensure vector index
  await kg.ensureVectorIndex().catch(() => {})

  // 1. Backfill clients → Person + Organisation nodes
  const clients = await db`SELECT * FROM clients WHERE archived_at IS NULL`
  logger.info(`Backfilling ${clients.length} clients`)
  for (const client of clients) {
    await kgHooks.onClientUpdated({ client }).catch(err =>
      logger.warn(`Failed to backfill client ${client.name}`, { error: err.message })
    )
  }

  // 2. Backfill projects → Project nodes + relationships
  const projects = await db`
    SELECT p.*, c.name AS client_name FROM projects p
    LEFT JOIN clients c ON p.client_id = c.id
    WHERE p.archived_at IS NULL
  `
  logger.info(`Backfilling ${projects.length} projects`)
  for (const project of projects) {
    await kgHooks.onProjectCreated({ project, clientName: project.client_name }).catch(err =>
      logger.warn(`Failed to backfill project ${project.name}`, { error: err.message })
    )
  }

  // 3. Backfill email threads → LLM extraction
  const threads = await db`SELECT * FROM email_threads ORDER BY received_at DESC LIMIT 50`
  logger.info(`Backfilling ${threads.length} email threads`)
  for (const thread of threads) {
    await kgHooks.onEmailProcessed({
      threadId: thread.id,
      fromEmail: thread.from_email,
      fromName: thread.from_name,
      subject: thread.subject,
      body: thread.full_body,
      snippet: thread.snippet,
      inbox: thread.inbox,
      clientId: thread.client_id,
    }).catch(err =>
      logger.warn(`Failed to backfill email ${thread.subject}`, { error: err.message })
    )

    // Small delay to avoid hammering the LLM
    await new Promise(r => setTimeout(r, 1000))
  }

  // 4. Backfill LinkedIn DMs if any exist
  try {
    const dms = await db`SELECT * FROM linkedin_dms ORDER BY last_message_at DESC LIMIT 30`
    logger.info(`Backfilling ${dms.length} LinkedIn DMs`)
    for (const dm of dms) {
      await kgHooks.onLinkedInDMProcessed({ dm }).catch(err =>
        logger.warn(`Failed to backfill DM ${dm.participant_name}`, { error: err.message })
      )
      await new Promise(r => setTimeout(r, 1000))
    }
  } catch {
    logger.info('No LinkedIn DMs table — skipping')
  }

  // 5. Embed all nodes
  logger.info('Embedding all nodes...')
  let totalEmbedded = 0
  let batch
  do {
    batch = await kg.embedStaleNodes(30)
    totalEmbedded += batch
    if (batch > 0) logger.info(`Embedded batch: ${batch} nodes (total: ${totalEmbedded})`)
  } while (batch > 0)

  logger.info(`KG backfill complete. Total embedded: ${totalEmbedded}`)

  // Stats
  const stats = await kg.getGraphStats()
  logger.info('Graph stats:', stats)

  await db.end()
  process.exit(0)
}

backfill().catch(err => {
  logger.error('Backfill failed', { error: err.message, stack: err.stack })
  process.exit(1)
})
