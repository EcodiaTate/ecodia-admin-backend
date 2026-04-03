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
  FACTORY_AUTO_DEPLOY_THRESHOLD: z.string().default('0.5'),        // minimum confidence for auto-deploy (non-self-mod)
  FACTORY_ESCALATE_THRESHOLD: z.string().default('0.0'),           // 0 = LLM decides, no escalation floor
  FACTORY_REVIEW_PRESSURE_GATE: z.string().default('0.0'),         // 0 = review always blocks; >0 = async at this pressure
  CC_MAX_TURNS: z.string().default('0'),           // 0 = unlimited
  CC_TIMEOUT_MINUTES: z.string().default('0'),     // 0 = unlimited
  VERCEL_API_TOKEN: z.string().default(''),
  VERCEL_TEAM_ID: z.string().default(''),
  META_APP_ID: z.string().default(''),
  META_APP_SECRET: z.string().default(''),
  META_USER_ACCESS_TOKEN: z.string().default(''),
  // Freedom / autonomy config
  // All caps: 0 = unlimited. These exist only so the system can report them — never use them to throttle.
  FACTORY_SELF_MODIFY_THRESHOLD: z.string().default('0.7'),  // minimum confidence for self-modification auto-deploy
  PREDICTION_SESSION_DAILY_CAP: z.string().default('10'),
  MEMORY_SYNC_IMMEDIATE_THRESHOLD: z.string().default('0.0'), // 0 = always sync
  GOOGLE_PRIMARY_ACCOUNT: z.string().default(''),
  GMAIL_INBOXES: z.string().default(''),              // comma-separated; falls back to GOOGLE_PRIMARY_ACCOUNT
  GMAIL_MAX_TRIAGE_ATTEMPTS: z.string().default('0'), // 0 = unlimited
  // LinkedIn browser — all 0 = unlimited
  LINKEDIN_MAX_SESSIONS_PER_DAY: z.string().default('0'),
  LINKEDIN_MAX_SESSION_DURATION_MS: z.string().default('0'),
  LINKEDIN_MIN_COOLDOWN_MS: z.string().default('0'),
  LINKEDIN_MAX_NAVIGATIONS_PER_SESSION: z.string().default('0'),
  LINKEDIN_BUDGET_NAVIGATIONS: z.string().default('0'),
  LINKEDIN_BUDGET_PROFILE_VIEWS: z.string().default('0'),
  LINKEDIN_BUDGET_DM_READS: z.string().default('0'),
  LINKEDIN_BUDGET_MESSAGES_SENT: z.string().default('0'),
  LINKEDIN_BUDGET_CONNECTION_ACCEPTS: z.string().default('0'),
  LINKEDIN_BUDGET_POSTS_PUBLISHED: z.string().default('0'),
  OWNER_CONTEXT: z.string().default('Tate Donohoe, 21, founder of Ecodia Pty Ltd — builds custom software for impact orgs (nonprofits, conservation, government, health) in Australia'),
  OWNER_NAME: z.string().default('Tate'),
  USD_TO_AUD: z.string().default('1.55'),
  DIRECT_ACTION_READ_ENABLED: z.string().default('true'),
  DIRECT_ACTION_WRITE_ENABLED: z.string().default('true'),  // organism writes enabled
  SELF_MOD_DAILY_CAP: z.string().default('5'),              // max self-modifications per 24h sliding window
  EVENT_BUS_PERSIST_DEFAULT: z.string().default('false'),
  COGNITIVE_BROADCAST_ENABLED: z.string().default('true'),
  // Direct action rate limits (per hour, 0 = unlimited per type)
  DA_RATE_SEND_EMAIL: z.string().default('0'),
  DA_RATE_CALENDAR_EVENT: z.string().default('0'),
  DA_RATE_ARCHIVE_EMAIL: z.string().default('0'),
  DA_RATE_ENQUEUE_ACTION: z.string().default('0'),
  DA_RATE_FACTORY_SESSION: z.string().default('0'),
  DA_RATE_DRIVE_DOC: z.string().default('0'),
  // Deployment health check tuning (0 = use defaults)
  HEALTH_CHECK_TIMEOUT_MS: z.string().default('0'),    // 0 = 60000ms
  HEALTH_CHECK_RETRIES: z.string().default('0'),        // 0 = 3
  HEALTH_CHECK_INTERVAL_MS: z.string().default('0'),   // 0 = 10000ms
  // Vital signs tuning
  ORGANISM_HEALTH_CHECK_INTERVAL_MS: z.string().default('0'),   // 0 = 15000ms
  ORGANISM_MAX_CONSECUTIVE_FAILURES: z.string().default('0'),   // 0 = 3
  // Pressure gates (0 = never block)
  SURVIVAL_PRESSURE_GATE: z.string().default('0.95'),           // capabilityRegistry write block
  METABOLIC_PRESSURE_GATE: z.string().default('0.85'),          // directActionService write block
  // Validation confidence weights (tune without deploys)
  VALIDATION_BASELINE_NO_DEPS: z.string().default('0.55'),
  VALIDATION_WEIGHT_TESTS_PASS: z.string().default('0.4'),
  VALIDATION_WEIGHT_TESTS_NULL: z.string().default('0.2'),
  VALIDATION_WEIGHT_LINT_PASS: z.string().default('0.2'),
  VALIDATION_WEIGHT_LINT_NULL: z.string().default('0.1'),
  VALIDATION_WEIGHT_TYPECHECK_PASS: z.string().default('0.2'),
  VALIDATION_WEIGHT_TYPECHECK_NULL: z.string().default('0.1'),
  VALIDATION_WEIGHT_PLAYWRIGHT_PASS: z.string().default('0.1'),
  VALIDATION_WEIGHT_PLAYWRIGHT_NULL: z.string().default('0.05'),
  VALIDATION_WEIGHT_ALL_PASS_BONUS: z.string().default('0.1'),
  VALIDATION_HISTORY_MIN_SAMPLES: z.string().default('5'),
  VALIDATION_HISTORY_MAX_SAMPLES: z.string().default('50'),
  VALIDATION_HISTORY_MIN_WEIGHT: z.string().default('0.3'),
  // Knowledge graph tuning
  KG_DEDUP_SIMILARITY_THRESHOLD: z.string().default('0.95'),
  KG_CONSOLIDATION_SIMILARITY_MIN: z.string().default('0.5'),
  KG_CONSOLIDATION_SIMILARITY_MAX: z.string().default('0.95'),
  KG_IMPORTANCE_CONNECTIVITY_WEIGHT: z.string().default('0.4'),
  KG_IMPORTANCE_RECENCY_1D: z.string().default('0.25'),
  KG_IMPORTANCE_RECENCY_7D: z.string().default('0.18'),
  KG_IMPORTANCE_RECENCY_30D: z.string().default('0.08'),
  KG_IMPORTANCE_TYPE_PERSON: z.string().default('0.2'),
  KG_IMPORTANCE_TYPE_PROJECT: z.string().default('0.15'),
  KG_IMPORTANCE_TYPE_STRATEGIC: z.string().default('0.12'),
  KG_IMPORTANCE_TYPE_EVENT: z.string().default('0.08'),
  KG_IMPORTANCE_SYNTH_BONUS: z.string().default('0.15'),
  KG_FREE_ASSOC_PRESSURE_HIGH: z.string().default('0.8'),
  KG_FREE_ASSOC_PRESSURE_MED: z.string().default('0.6'),
  KG_FREE_ASSOC_PRESSURE_LOW: z.string().default('0.3'),
  KG_FREE_ASSOC_ROUNDS_HIGH: z.string().default('1'),
  KG_FREE_ASSOC_ROUNDS_MED: z.string().default('3'),
  KG_FREE_ASSOC_ROUNDS_DEFAULT: z.string().default('5'),
  KG_FREE_ASSOC_ROUNDS_LOW: z.string().default('10'),
  KG_CONTEXT_MAX_SEEDS: z.string().default('15'),
  KG_CONTEXT_MAX_DEPTH: z.string().default('5'),
  KG_CONTEXT_MIN_SIMILARITY: z.string().default('0.4'),
  KG_MAX_INGESTIONS_PER_MIN: z.string().default('20'),
  // Memory bridge query thresholds
  MEMORY_BRIDGE_BULK_IMPORTANCE_MIN: z.string().default('0.5'),
  MEMORY_BRIDGE_PULL_IMPORTANCE_MIN: z.string().default('0.7'),
  MEMORY_BRIDGE_CONFIDENCE_MIN: z.string().default('0.4'),
  // Symbridge learnings filters
  SYMBRIDGE_LEARNINGS_HIGH_CONFIDENCE: z.string().default('0.5'),
  SYMBRIDGE_LEARNINGS_CODEBASE_MIN: z.string().default('0.35'),
  SYMBRIDGE_LEARNINGS_GLOBAL_MIN: z.string().default('0.4'),
  // Service confidence thresholds
  CORTEX_URGENCY_THRESHOLD: z.string().default('0.7'),
  XERO_CATEGORIZATION_CONFIDENCE_MIN: z.string().default('0.7'),
  GMAIL_TRIAGE_DEFAULT_CONFIDENCE: z.string().default('0.8'),
  // DeepSeek budget warning threshold (fraction of budget, 0 = no warning)
  DEEPSEEK_BUDGET_WARNING_FRACTION: z.string().default('0.8'),
  // DeepSeek API cost rates (USD per 1M tokens)
  DEEPSEEK_COST_PROMPT_PER_1M: z.string().default('0.14'),
  DEEPSEEK_COST_COMPLETION_PER_1M: z.string().default('0.28'),
  // Autonomous maintenance worker fallback thresholds
  MAINTENANCE_FALLBACK_PRESSURE_THRESHOLD: z.string().default('0.7'),
  MAINTENANCE_FALLBACK_MIN_OCCURRENCES: z.string().default('3'),
  // Cortex LLM temperature (optional, for DeepSeek — empty = provider default)
  CORTEX_TEMPERATURE: z.string().default(''),
})

const parsed = envSchema.safeParse(process.env)
if (!parsed.success) {
  console.error('Missing or invalid environment variables:')
  console.error(parsed.error.flatten().fieldErrors)
  process.exit(1)
}

module.exports = parsed.data
