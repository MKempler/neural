-- Fresh-context handoffs: near a full context window the session writes its state down and is restarted
-- afresh instead of being compacted. NULL means the default: on for the orchestrator, off for workers.
ALTER TABLE sessions ADD COLUMN handoff INTEGER;
