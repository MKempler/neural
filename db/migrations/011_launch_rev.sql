-- A fingerprint of how each session was launched (Neural's hooks, status line, channel server). When Neural's
-- setup changes, a session started before the change is restarted, once idle, to pick it up.
ALTER TABLE sessions ADD COLUMN launch_rev TEXT;
