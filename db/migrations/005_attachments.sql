-- Files attached to messages: photos, videos and anything else, from the user or from a session.
CREATE TABLE attachments (
  id          INTEGER PRIMARY KEY,
  message_id  INTEGER REFERENCES messages(id),   -- NULL while uploaded but not yet sent
  kind        TEXT NOT NULL,                      -- image | video | file
  name        TEXT NOT NULL,                      -- original file name
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  path        TEXT NOT NULL,                      -- the original, as uploaded
  view_path   TEXT,                               -- what Claude opens: JPEG for HEIC, resized when huge
  poster_path TEXT,                               -- video: a still for the player
  frames      TEXT,                               -- video: JSON array of still-frame paths
  width       INTEGER,
  height      INTEGER,
  duration    REAL,                               -- video seconds
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX attachments_message ON attachments(message_id);
