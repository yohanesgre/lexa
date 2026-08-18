-- Retire the Forge runtime MCP-link column (2026-08-18)
-- The Lexa MCP server is deleted; the daemon no longer probes /mcp and the
-- heartbeat no longer reports mcp_connected.
ALTER TABLE runtimes DROP COLUMN mcp_connected;
