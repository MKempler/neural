-- The model and effort a session is started with (Claude Code's --model and --effort), kept across restarts.
-- NULL: Claude Code's own default. (model and effort hold what the session reports it is actually using.)
ALTER TABLE sessions ADD COLUMN launch_model TEXT;
ALTER TABLE sessions ADD COLUMN launch_effort TEXT;
