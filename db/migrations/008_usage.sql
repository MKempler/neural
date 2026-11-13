-- The latest readings from Claude Code's status line: each session's context window and cost, and (under the
-- name '') the account's usage limits. Kept apart from sessions so a reading doesn't move sessions.updated_at.
CREATE TABLE usage (
  name TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
