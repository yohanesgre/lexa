-- 0010: remove local stdio MCP clients. Lexa connects to REMOTE MCP servers
-- (http/sse) only; a stdio client could only ever spawn a local process, which
-- is impossible on Cloudflare Workers.
--
-- Row cleanup only — no table rebuild, no ALTER, no DROP COLUMN: D1 supports
-- neither ALTER/DROP COLUMN nor a CHECK rewrite, and `command`/`args` stay as
-- the historical 0009 shape for compatibility.
--
-- Junction rows go FIRST. The Bun runner executes with `PRAGMA foreign_keys =
-- OFF` (server/db/migrate.ts), so ON DELETE CASCADE never fires there and
-- deleting only the parent would orphan every binding; the D1 runner enforces
-- foreign keys, so the parent DELETE must not be the only cleanup. Doing the
-- junction DELETE first is correct under both runners.
DELETE FROM assistant_mcp_project_servers
WHERE server_id IN (
  SELECT id FROM assistant_mcp_servers WHERE transport_type = 'stdio'
);

DELETE FROM assistant_mcp_servers WHERE transport_type = 'stdio';
