-- What each session spends, from the cost its status line reports: one row per increase, so the share of a
-- usage-limit window each session used can be added up. Rows older than the weekly window are pruned.
CREATE TABLE usage_log (
  id INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  cost REAL NOT NULL
);
CREATE INDEX usage_log_ts ON usage_log (ts);

-- high, normal or low. Near a usage limit, low-priority sessions are the ones to pause.
ALTER TABLE sessions ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal';
