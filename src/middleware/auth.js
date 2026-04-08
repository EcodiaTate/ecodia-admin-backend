const jwt = require('jsonwebtoken')
const env = require('../config/env')

function authMiddleware(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid authorization header' })
  }

  const token = header.slice(7)

  // Internal MCP servers use a static long-lived token (MCP_INTERNAL_TOKEN env var).
  // This avoids needing to refresh JWTs inside MCP server processes.
  if (env.MCP_INTERNAL_TOKEN && token === env.MCP_INTERNAL_TOKEN) {
    req.user = { id: 'internal', role: 'internal' }
    return next()
  }

  try {
    const decoded = jwt.verify(token, env.JWT_SECRET)
    req.user = decoded
    next()
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}

module.exports = authMiddleware
