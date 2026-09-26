-- 0009: assistant MCP server registry.
-- New tables only (no rebuild, no ALTER — safe on both runners).
-- `assistant_mcp_servers` is the global registry (superadmin-managed);
-- `assistant_mcp_project_servers` is the per-project availability junction
-- (absence = unavailable). FK column types match assistant_settings.project_id
-- (projects.id) so the join is type-consistent.
-- The CHECK pins exactly one transport shape per row: http/sse carry a url
-- and no command; stdio carries a command and no url.
-- Seeds a single disabled stdio `jev` row — never auto-enabled (stdio runs
-- only on the same-host Bun server; impossible on Cloudflare Workers).
-- secret_ref stores only a reference ('env:NAME' | 'file:/abs/path'), never a
-- plaintext credential.

CREATE TABLE assistant_mcp_servers (
  id TEXT PRIMARY KEY,                                  -- stable slug, e.g. 'jev'
  label TEXT NOT NULL,
  transport_type TEXT NOT NULL CHECK (transport_type IN ('http','sse','stdio')),
  url TEXT,
  command TEXT,
  args TEXT NOT NULL DEFAULT '[]',                      -- JSON array of strings
  secret_ref TEXT,                                      -- 'env:NAME' | 'file:/abs/path', never plaintext
  enabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (transport_type IN ('http','sse') AND url IS NOT NULL AND command IS NULL)
    OR (transport_type = 'stdio' AND command IS NOT NULL AND url IS NULL)
  )
);

CREATE TABLE assistant_mcp_project_servers (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  server_id TEXT NOT NULL REFERENCES assistant_mcp_servers(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, server_id)
);

INSERT OR IGNORE INTO assistant_mcp_servers (id, label, transport_type, command, args, enabled)
VALUES ('jev', 'Jev', 'stdio', 'jev-mcp', '[]', 0);
