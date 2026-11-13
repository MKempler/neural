-- Questions Claude asks (AskUserQuestion) and plans it presents for approval (ExitPlanMode), so they can be
-- answered from the app. The answer is typed into the dialog in the session's terminal.
CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  session TEXT NOT NULL,
  tool_use_id TEXT,
  kind TEXT NOT NULL,                  -- 'question' or 'plan'
  payload TEXT NOT NULL,               -- the tool's input: { questions: [...] } or { plan }
  state TEXT NOT NULL DEFAULT 'open',  -- open, answered (from the app), closed (answered elsewhere, or moved on)
  answer TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_at TEXT
);
CREATE INDEX questions_open ON questions (session) WHERE state = 'open';
