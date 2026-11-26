-- The model provider a session runs Claude Code on (providers.ts), kept across restarts like launch_model.
-- NULL: Anthropic, Claude Code's own login.
ALTER TABLE sessions ADD COLUMN provider TEXT;
