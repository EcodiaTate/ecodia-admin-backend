const logger = require('../config/logger')

function errorHandler(err, req, res, _next) {
  logger.error(err.message, { stack: err.stack, path: req.path, method: req.method })

  if (err.name === 'ZodError') {
    return res.status(400).json({ error: 'Validation error', details: err.flatten().fieldErrors })
  }

  const status = err.status || 500
  res.status(status).json({
    error: status === 500 ? 'Internal server error' : err.message,
  })
}

module.exports = errorHandler
