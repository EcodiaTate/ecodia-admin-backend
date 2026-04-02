-- ═══════════════════════════════════════════════════════════════════════
-- 017: Organism Codebase Registration
--
-- Registers the organism and EcodiaOS backend as codebases the Factory
-- can target for autonomous repair via Thymos incident dispatches.
-- ═══════════════════════════════════════════════════════════════════════

INSERT INTO codebases (name, repo_path, language, meta)
VALUES
  (
    'organism',
    '/home/tate/organism',
    'python',
    '{"description": "EOS organism — Python/FastAPI cognitive system (Synapse, Thymos, Nova, Oikos, Axon, etc.)", "pm2_name": "organism", "health_endpoint": "http://localhost:8000/health"}'
  ),
  (
    'ecodia-admin-backend',
    '/home/tate/ecodia-admin/backend',
    'javascript',
    '{"description": "EcodiaOS admin hub backend — Node.js/Express, primary Factory codebase", "pm2_name": "ecodia-api"}'
  ),
  (
    'ecodia-admin-frontend',
    '/home/tate/ecodia-admin/frontend',
    'javascript',
    '{"description": "EcodiaOS admin hub frontend — React/Vite", "pm2_name": null}'
  )
ON CONFLICT (name) DO UPDATE
  SET
    repo_path = EXCLUDED.repo_path,
    language  = EXCLUDED.language,
    meta      = codebases.meta || EXCLUDED.meta;
