-- Spend on non-Anthropic providers, metered from transcript token counts at list prices, per session and day (UTC).
-- Kept apart from usage_log, which estimates shares of the Claude plan's windows.
CREATE TABLE provider_usage (
  session TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  day TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  cached INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  replies INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session, provider, model, day)
);
