-- Scheduled jobs Neural runs itself: a shell command, or a prompt sent to a session. Each run's outcome and
-- output are kept, and failures are reported to the orchestrator, so a job that breaks doesn't go unnoticed.
CREATE TABLE jobs (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  schedule TEXT NOT NULL,
  command TEXT,                 -- a shell command, run with /bin/sh -c in cwd
  session TEXT,                 -- or: the session a prompt is sent to
  prompt TEXT,
  cwd TEXT,
  timeout_s INTEGER NOT NULL DEFAULT 3600,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  next_run_at TEXT,
  failures INTEGER NOT NULL DEFAULT 0  -- failed runs in a row
);

CREATE TABLE job_runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running, ok, failed, timeout, interrupted
  exit_code INTEGER,
  output TEXT,
  trigger TEXT NOT NULL DEFAULT 'schedule' -- schedule or manual
);
CREATE INDEX job_runs_job ON job_runs (job_id, id);
