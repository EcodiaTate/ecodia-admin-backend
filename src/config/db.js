const postgres = require('postgres')
const env = require('./env')

const db = postgres(env.DATABASE_URL, {
  max: parseInt(env.DB_POOL_MAX || '10'),
  idle_timeout: parseInt(env.DB_IDLE_TIMEOUT || '30'),
  connect_timeout: parseInt(env.DB_CONNECT_TIMEOUT || '10'),
  // Reconnect on connection loss — prevents 500s during PM2 restarts
  // when Supabase connections are briefly interrupted
  max_lifetime: parseInt(env.DB_MAX_LIFETIME || '1800'),  // 30min — recycle stale connections
})

module.exports = db
