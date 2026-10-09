-- ============================================================================
-- GameForge AI Studio — 0002_seed
-- Default application_settings. Idempotent (ON CONFLICT DO NOTHING).
-- NO secret values here — non-secret config only (DATABASE.md §1.22 rule).
-- ============================================================================

INSERT INTO application_settings (key, value) VALUES
  ('language',           '"en"'),
  ('theme',              '"dark"'),
  ('defaultMode',        '"auto"'),
  ('maxParallelAgents',  '2'),
  ('maxRetries',         '3'),
  ('maxRunMinutes',      '120'),
  ('aiBudgetUsd',        '5'),
  ('assetStorageMb',     '2048'),
  ('previewQuality',     '"medium"'),
  ('sound',              'true'),
  ('confirmations',      'true')
ON CONFLICT (key) DO NOTHING;
