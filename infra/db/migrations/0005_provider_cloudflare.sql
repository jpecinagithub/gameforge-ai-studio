-- 0005: model_registry provider default moves from 'groq' to 'cloudflare'.
-- 2026-10-09: the studio's LLM provider is Cloudflare Workers AI
-- (user decision). 0001_init.sql is immutable, so the default changes here.
-- Existing rows keep whatever provider value they were inserted with.
ALTER TABLE model_registry ALTER COLUMN provider SET DEFAULT 'cloudflare';
