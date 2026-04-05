const logger = require('../config/logger')

function errorHandler(err, req, res, _next) {
  logger.error(err.message, { stack: err.stack, path: req.path, method: req.method })

  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation error', details: err.flatten().fieldErrors })
  }

  const status = err.status || err.statusCode || 500
  // Always return actual error — single-user admin system, hiding errors helps nobody
  res.status(status).json({
    error: err.message || 'Internal server error',
    ...(err.response?.data && { upstream: err.response.data }),
  })
}

module.exports = errorHandler
