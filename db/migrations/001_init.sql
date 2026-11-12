CREATE TABLE sessions (
  id                INTEGER PRIMARY KEY,
  name              TEXT NOT NULL UNIQUE,
  role              TEXT NOT NULL DEFAULT 'worker',      -- orchestrator | worker
  cwd               TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'starting',    -- starting | idle | working | blocked | attention | exited | stopped
  status_detail     TEXT,
  channel_connected INTEGER NOT NULL DEFAULT 0,
  claude_session_id TEXT,
  transcript_path   TEXT,
  autostart         INTEGER NOT NULL DEFAULT 0,
  restarts          INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ended_at          TEXT
);

-- Every message between the user and sessions, and between sessions.
CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,
  ts          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  from_name   TEXT NOT NULL,          -- 'user' | 'system' | session name
  to_name     TEXT NOT NULL,          -- 'user' | session name
  body        TEXT NOT NULL,
  source      TEXT NOT NULL,          -- ui | reply | send_message | stop_hook | system
  in_reply_to INTEGER,
  meta        TEXT
);
CREATE INDEX messages_to   ON messages(to_name, id);
CREATE INDEX messages_from ON messages(from_name, id);

-- Delivery state for messages addressed to a session.
CREATE TABLE outbox (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id),
  target     TEXT NOT NULL,
  state      TEXT NOT NULL DEFAULT 'pending',   -- pending | pushed | acked | failed
  via        TEXT,                              -- channel | paste
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  pushed_at  TEXT,
  acked_at   TEXT,
  acked_by   TEXT
);
CREATE INDEX outbox_target ON outbox(target, state, message_id);

-- Archived Claude Code transcript lines (raw line kept so nothing is lost if the format changes).
CREATE TABLE transcript_entries (
  id                INTEGER PRIMARY KEY,
  claude_session_id TEXT NOT NULL,
  session_name      TEXT,
  project           TEXT,
  uuid              TEXT NOT NULL UNIQUE,
  ts                TEXT,
  role              TEXT,
  text              TEXT,
  raw               TEXT NOT NULL
);
CREATE INDEX transcript_session ON transcript_entries(claude_session_id, id);

CREATE TABLE transcript_files (
  path   TEXT PRIMARY KEY,
  offset INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE events (
  id      INTEGER PRIMARY KEY,
  ts      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  session TEXT,
  event   TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX events_session ON events(session, id);

CREATE TABLE permission_requests (
  id            INTEGER PRIMARY KEY,
  ts            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  session       TEXT NOT NULL,
  request_id    TEXT NOT NULL,
  tool_name     TEXT,
  description   TEXT,
  input_preview TEXT,
  verdict       TEXT,
  decided_at    TEXT
);

CREATE VIRTUAL TABLE messages_fts USING fts5(body, content='messages', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, body) VALUES (new.id, new.body);
END;
CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, body) VALUES ('delete', old.id, old.body);
END;

CREATE VIRTUAL TABLE transcript_fts USING fts5(text, content='transcript_entries', content_rowid='id', tokenize='porter unicode61');
CREATE TRIGGER transcript_ai AFTER INSERT ON transcript_entries WHEN new.text IS NOT NULL BEGIN
  INSERT INTO transcript_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER transcript_ad AFTER DELETE ON transcript_entries WHEN old.text IS NOT NULL BEGIN
  INSERT INTO transcript_fts(transcript_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
