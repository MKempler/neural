-- A short status note a session sets about itself (phase, what it is waiting on, next step), shown to the
-- orchestrator and on Home.
ALTER TABLE sessions ADD COLUMN note TEXT;
ALTER TABLE sessions ADD COLUMN note_at TEXT;
