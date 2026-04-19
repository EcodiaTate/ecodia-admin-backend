const postgres = require('postgres')
const env = require('./env')
const logger = require('./logger')

// Supabase's pgbouncer pooler closes idle connections silently after ~60s.
// postgres.js doesn't always notice before the next write lands, which
// surfaces as `write CONNECTION_ENDED aws-1-ap-southeast-2.pooler.supabase.com`.
// Defence:
//   - idle_timeout: 20s — shorter than pgbouncer's window, so we close first
//   - max_lifetime: 600s — recycle every 10 min, not 30, so stale sockets
//                          die before they're reused on a hot path
//   - onnotice: swallow informational NOTICE spam from migrations
const db = postgres(env.DATABASE_URL, {
  max: parseInt(env.DB_POOL_MAX || '10'),
  idle_timeout: parseInt(env.DB_IDLE_TIMEOUT || '20'),
  connect_timeout: parseInt(env.DB_CONNECT_TIMEOUT || '10'),
  max_lifetime: parseInt(env.DB_MAX_LIFETIME || '600'),
  onnotice: () => {},
})

module.exports = db
