-- Runtime MCP connectivity: the daemon verifies its Lexa MCP connection
-- (initialize + ping against /mcp) on every heartbeat and reports it.
-- Runtimes without a connected MCP are not allowed to run Forge tasks.
ALTER TABLE runtimes ADD COLUMN mcp_connected INTEGER NOT NULL DEFAULT 0;
