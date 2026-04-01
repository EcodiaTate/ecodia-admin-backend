const { Router } = require('express')
const bcrypt = require('bcrypt')
const jwt = require('jsonwebtoken')
const { z } = require('zod')
const env = require('../config/env')
const validate = require('../middleware/validate')
const auth = require('../middleware/auth')
const { createTicket } = require('../websocket/wsManager')

const router = Router()

const loginSchema = z.object({
  password: z.string().min(1),
})

// Single-user auth — password checked against env DASHBOARD_PASSWORD_HASH
router.post('/login', validate(loginSchema), async (req, res, next) => {
  try {
    const valid = await bcrypt.compare(req.body.password, env.DASHBOARD_PASSWORD_HASH)
    if (!valid) {
      return res.status(401).json({ error: 'Invalid password' })
    }

    const token = jwt.sign({ userId: 'admin' }, env.JWT_SECRET, { expiresIn: '24h' })
    const refreshToken = jwt.sign({ userId: 'admin', type: 'refresh' }, env.JWT_SECRET, {
      expiresIn: '7d',
    })

    res.json({ token, refreshToken })
  } catch (err) {
    next(err)
  }
})

router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body
    if (!refreshToken) return res.status(400).json({ error: 'Missing refresh token' })

    const decoded = jwt.verify(refreshToken, env.JWT_SECRET)
    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' })
    }

    const token = jwt.sign({ userId: 'admin' }, env.JWT_SECRET, { expiresIn: '24h' })
    res.json({ token })
  } catch (err) {
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Invalid or expired refresh token' })
    }
    next(err)
  }
})

// Issue a short-lived WS ticket (authenticated)
router.post('/ws-ticket', auth, (req, res) => {
  const ticket = createTicket(req.user.userId)
  res.json({ ticket })
})

module.exports = router
