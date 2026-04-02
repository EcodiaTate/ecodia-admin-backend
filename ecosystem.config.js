const COMMON = {
  cwd: '/home/tate/ecodiaos',
  watch: false,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 2000,
  exp_backoff_restart_delay: 100,
  env: { NODE_ENV: 'production' },
}
module.exports = {
  apps: [
    { ...COMMON, name: 'ecodia-api', script: 'src/server.js', max_memory_restart: '600M', env: { ...COMMON.env, PORT: 3001 } },
    { ...COMMON, name: 'ecodia-gmail', script: 'src/workers/gmailPoller.js' },
    { ...COMMON, name: 'ecodia-linkedin', script: 'src/workers/linkedinWorker.js', max_restarts: 30, restart_delay: 5000 },
    { ...COMMON, name: 'ecodia-finance', script: 'src/workers/financePoller.js' },
    { ...COMMON, name: 'ecodia-kg-embed', script: 'src/workers/kgEmbeddingWorker.js' },
    { ...COMMON, name: 'ecodia-kg-consolidation', script: 'src/workers/kgConsolidationWorker.js' },
  ],
}
