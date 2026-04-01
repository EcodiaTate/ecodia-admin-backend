const postgres = require('postgres')
const env = require('./env')

const db = postgres(env.DATABASE_URL, {
  max: 20,
  idle_timeout: 30,
  connect_timeout: 10,
})

module.exports = db
