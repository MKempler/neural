-- Browsers and phones that asked for notifications (Web Push subscriptions).
CREATE TABLE push_subscriptions (
  endpoint     TEXT PRIMARY KEY,
  subscription TEXT NOT NULL,
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_ok_at   TEXT,
  last_error   TEXT
);
