require('dotenv').config()
const { z } = require('zod')

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('3001'),
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(32),
  DASHBOARD_PASSWORD_HASH: z.string().min(1),
  ENCRYPTION_KEY: z.string().length(64),
  XERO_CLIENT_ID: z.string().default(''),
  XERO_CLIENT_SECRET: z.string().default(''),
  XERO_TENANT_ID: z.string().default(''),
  XERO_REDIRECT_URI: z.string().default('https://api.admin.ecodia.au/api/finance/xero/callback'),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default('{}'),
  LINKEDIN_EMAIL: z.string().default(''),
  LINKEDIN_PASSWORD: z.string().default(''),
  DEEPSEEK_API_KEY: z.string().default(''),
  ANTHROPIC_API_KEY: z.string().default(''),
  NEO4J_URI: z.string().default(''),
  NEO4J_USER: z.string().default('neo4j'),
  NEO4J_PASSWORD: z.string().default(''),
  OPENAI_API_KEY: z.string().default(''),
  BACKUP_DIR: z.string().optional(),
  RCLONE_BACKUP_REMOTE: z.string().optional(),
  CLAUDE_CLI_PATH: z.string().default('claude'),
  REDIS_URL: z.string().default(''),
  SYMBRIDGE_SECRET: z.string().default(''),
  ORGANISM_API_URL: z.string().default(''),
  FACTORY_AUTO_DEPLOY_THRESHOLD: z.string().default('0.7'),
  FACTORY_ESCALATE_THRESHOLD: z.string().default('0.4'),
  CC_MAX_TURNS: z.string().default('200'),
  CC_TIMEOUT_MINUTES: z.string().default('120'),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Missing or invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

module.exports = parsed.data
