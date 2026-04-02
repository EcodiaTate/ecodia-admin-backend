-- ═══════════════════════════════════════════════════════════════════════
-- 017: Organism Codebase Registration
--
-- Registers the organism and EcodiaOS backend as codebases the Factory
-- can target for autonomous repair via Thymos incident dispatches.
--
-- VPS layout:
--   /home/tate/ecodiaos  — EcodiaOS backend (src/server.js at root, no /backend subdir)
--   /home/tate/organism  — Organism (Python/FastAPI)
--   Frontend deploys via Vercel — not present on VPS
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO codebases (name, repo_path, language, meta)
VALUES
  (
    'organism-backend',
    '/home/tate/organism',
    'python',
    '{"description": "EOS organism — Python/FastAPI cognitive system (Synapse, Thymos, Nova, Oikos, Axon, etc.)", "deploy_target": "pm2", "pm2_name": "organism", "health_check_url": "http://localhost:8000/health", "branch": "main"}'
  ),
  (
    'ecodiaos-backend',
    '/home/tate/ecodiaos',
    'javascript',
    '{"description": "EcodiaOS admin hub — Node.js/Express, src/server.js at repo root", "deploy_target": "pm2", "pm2_name": "ecodia-api", "health_check_url": "http://localhost:3001/api/health", "branch": "main"}'
  )
ON CONFLICT (name) DO UPDATE
  SET
    repo_path = EXCLUDED.repo_path,
    language  = EXCLUDED.language,
    meta      = codebases.meta || EXCLUDED.meta;
