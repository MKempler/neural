-- Pieces of messages and transcript entries that have been embedded for semantic search.
-- The vectors themselves live in a sqlite-vec table (chunk_vecs) created at startup when the extension loads.
CREATE TABLE chunks (
  id     INTEGER PRIMARY KEY,
  kind   TEXT NOT NULL,      -- message | transcript
  ref_id INTEGER NOT NULL,   -- messages.id or transcript_entries.id
  seq    INTEGER NOT NULL,
  text   TEXT NOT NULL
);
CREATE INDEX chunks_ref ON chunks(kind, ref_id);

-- How far the embedder has got through each source table.
CREATE TABLE embed_state (
  kind    TEXT PRIMARY KEY,
  last_id INTEGER NOT NULL
);
