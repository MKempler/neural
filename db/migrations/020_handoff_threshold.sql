-- Per-session handoff thresholds: a context percent, or a number of tokens (cost grows with context size, so
-- a large window is better handed off by size). NULL: the default for the session's role.
ALTER TABLE sessions ADD COLUMN handoff_at INTEGER;
ALTER TABLE sessions ADD COLUMN handoff_tokens INTEGER;
