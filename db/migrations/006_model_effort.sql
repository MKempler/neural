-- The model and effort level each session is actually using, as Claude Code reports them.
ALTER TABLE sessions ADD COLUMN model TEXT;
ALTER TABLE sessions ADD COLUMN effort TEXT;
