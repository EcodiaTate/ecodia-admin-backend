const COMMON = {
  cwd: '/home/tate/ecodiaos',
  watch: false,
  max_restarts: 20,
  min_uptime: '10s',
  restart_delay: 2000,
  exp_backoff_restart_delay: 100,
  kill_timeout: 45000,
  env: { NODE_ENV: 'production' },
}
module.exports = {
  apps: [
    { ...COMMON, name: 'ecodia-api', script: 'src/server.js', max_memory_restart: '2G', env: { ...COMMON.env, PORT: 3001 } },
    // Factory runner — owns all CC session child processes.
    // Runs separately from ecodia-api so CC sessions survive API restarts (e.g. self-modification deploys).
    // Communicates with ecodia-api via Redis pub/sub (factoryBridge).
    { ...COMMON, name: 'ecodia-factory', script: 'src/workers/factoryRunner.js', max_memory_restart: '3G', max_restarts: 10, restart_delay: 5000 },
    // Gmail poller is on-demand only — called by autonomousMaintenanceWorker.
    // Not a long-running process; removed from PM2 to stop the restart loop.
    // { ...COMMON, name: 'ecodia-gmail', script: 'src/workers/gmailPoller.js' },
    { ...COMMON, name: 'ecodia-linkedin', script: 'src/workers/linkedinWorker.js', max_restarts: 30, restart_delay: 5000 },
    { ...COMMON, name: 'ecodia-finance', script: 'src/workers/financePoller.js' },
    { ...COMMON, name: 'ecodia-kg-embed', script: 'src/workers/kgEmbeddingWorker.js' },
    { ...COMMON, name: 'ecodia-kg-consolidation', script: 'src/workers/kgConsolidationWorker.js' },
  ],
}
