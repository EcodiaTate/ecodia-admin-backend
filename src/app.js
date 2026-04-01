const express = require('express')
const helmet = require('helmet')
const cors = require('cors')
const compression = require('compression')
const errorHandler = require('./middleware/errorHandler')

const authRoutes = require('./routes/auth')
const financeRoutes = require('./routes/finance')
const gmailRoutes = require('./routes/gmail')
const linkedinRoutes = require('./routes/linkedin')
const crmRoutes = require('./routes/crm')
const claudeCodeRoutes = require('./routes/claudeCode')
const taskRoutes = require('./routes/tasks')
const settingsRoutes = require('./routes/settings')
const kgRoutes = require('./routes/knowledgeGraph')
const cortexRoutes = require('./routes/cortex')

const app = express()

// Middleware
app.use(helmet())
app.use(cors({
  origin: (origin, callback) => {
    const allowed = [
      'https://admin.ecodia.au',
      'http://localhost:5173',
    ]
    if (!origin || allowed.includes(origin) || origin.endsWith('.vercel.app')) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  },
  credentials: true,
}))
app.use(compression())
app.use(express.json({ limit: '5mb' }))

// Health check (no auth)
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// Routes
app.use('/api/auth', authRoutes)
app.use('/api/finance', financeRoutes)
app.use('/api/gmail', gmailRoutes)
app.use('/api/linkedin', linkedinRoutes)
app.use('/api/crm', crmRoutes)
app.use('/api/cc', claudeCodeRoutes)
app.use('/api/tasks', taskRoutes)
app.use('/api/settings', settingsRoutes)
app.use('/api/kg', kgRoutes)
app.use('/api/cortex', cortexRoutes)

// Error handler (must be last)
app.use(errorHandler)

module.exports = app
