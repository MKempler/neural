-- Extra MCP servers a session is started with besides Neural's own (JSON: name -> Claude Code server config).
ALTER TABLE sessions ADD COLUMN mcp_servers TEXT;
