const neo4j = require('neo4j-driver')
const env = require('./env')
const logger = require('./logger')

let driver = null

function getDriver() {
  if (!env.NEO4J_URI) {
    return null
  }

  if (!driver) {
    driver = neo4j.driver(
      env.NEO4J_URI,
      neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD),
      {
        maxConnectionPoolSize: 10,
        connectionAcquisitionTimeout: 10000,
      }
    )
    logger.info('Neo4j driver initialized')
  }

  return driver
}

async function runQuery(cypher, params = {}) {
  const d = getDriver()
  if (!d) throw new Error('Neo4j not configured')

  const session = d.session()
  try {
    const result = await session.run(cypher, params)
    return result.records
  } finally {
    await session.close()
  }
}

async function runWrite(cypher, params = {}) {
  const d = getDriver()
  if (!d) throw new Error('Neo4j not configured')

  const session = d.session()
  try {
    const result = await session.executeWrite(tx => tx.run(cypher, params))
    return result.records
  } finally {
    await session.close()
  }
}

async function healthCheck() {
  try {
    await runQuery('RETURN 1')
    return true
  } catch {
    return false
  }
}

module.exports = { getDriver, runQuery, runWrite, healthCheck }
