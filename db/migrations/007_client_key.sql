-- The key the web app gives each message it sends, so a send retried after a lost response is stored only once.
ALTER TABLE messages ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX messages_client_key ON messages(client_key) WHERE client_key IS NOT NULL;
