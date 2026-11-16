-- Why a session is down and what Neural is doing about it (JSON: kind, reason, hint, retry_at, attempt, max),
-- shown in the app. Cleared when the session is up again.
ALTER TABLE sessions ADD COLUMN down TEXT;
