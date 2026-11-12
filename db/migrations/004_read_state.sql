-- How far the user has read each session's replies. Kept on the server so phone and desktop agree.
CREATE TABLE read_state (
  session      TEXT PRIMARY KEY,
  last_read_id INTEGER NOT NULL
);
-- Everything that existed before this table counts as read.
INSERT INTO read_state (session, last_read_id)
  SELECT name, COALESCE((SELECT max(id) FROM messages), 0) FROM sessions;
