const db = require('../../config/db')

async function findClientByEmail(email) {
  const [client] = await db`SELECT * FROM clients WHERE email = ${email} AND archived_at IS NULL`
  return client || null
}

async function findClientByLinkedIn(profileUrl) {
  const [client] = await db`SELECT * FROM clients WHERE linkedin_url = ${profileUrl} AND archived_at IS NULL`
  return client || null
}

module.exports = { findClientByEmail, findClientByLinkedIn }
