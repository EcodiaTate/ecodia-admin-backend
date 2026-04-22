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
const codebaseRoutes = require('./routes/codebase')
const workerRoutes = require('./routes/workers')
const driveRoutes = require('./routes/drive')
const vercelRoutes = require('./routes/vercel')
const metaRoutes = require('./routes/meta')
const actionQueueRoutes = require('./routes/actionQueue')
const contextTrackingRoutes = require('./routes/contextTracking')
const kgExplorerRoutes = require('./routes/kgExplorer')
const momentumRoutes = require('./routes/momentum')
const internalCortexStateRoutes = require('./routes/internalCortexState')
const bookkeepingRoutes = require('./routes/bookkeeping')
const codingRoutes = require('./routes/coding')
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
app.use(express.urlencoded({ extended: false }))

// Health check (no auth)
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }))

// Static file serving — generated docs, invoices, reports (no auth needed, files are not guessable)
const path = require('path')
app.use('/api/files', express.static(path.join(__dirname, '../public')))

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
app.use('/api/codebase', codebaseRoutes)
app.use('/api/workers', workerRoutes)
app.use('/api/drive', driveRoutes)
app.use('/api/vercel', vercelRoutes)
app.use('/api/meta', metaRoutes)
app.use('/api/actions', actionQueueRoutes)
app.use('/api/context', contextTrackingRoutes)
app.use('/kg-explorer', kgExplorerRoutes)
app.use('/api/momentum', momentumRoutes)
app.use('/internal/cortex-state', internalCortexStateRoutes)
app.use('/api/bookkeeping', bookkeepingRoutes)
app.use('/api/coding', codingRoutes)
app.use('/api/xero', require('./routes/xero'))
app.use('/api/message-queue', require('./routes/messageQueue'))
app.use('/api/os-session', require('./routes/osSession'))
app.use('/api/sms', require('./routes/smsWebhook'))
app.use('/api/docs', require('./routes/documents'))
app.use('/api/dashboard', require('./routes/dashboard'))

// Error handler (must be last)
app.use(errorHandler)

module.exports = app
