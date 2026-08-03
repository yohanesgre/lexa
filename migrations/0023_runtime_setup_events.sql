-- ============================================================
-- 0023 — Forge: machine-scoped runtime setup events
-- ============================================================
-- Setup events target a machine. Runtime execution settings stay on the
-- runtime row and are configured after installation from Settings.
ALTER TABLE runtime_events RENAME TO runtime_events_old;
DROP INDEX idx_runtime_events_status;

CREATE TABLE runtime_events (
  id          TEXT PRIMARY KEY,
  machine_id  TEXT NOT NULL,
  action      TEXT NOT NULL DEFAULT 'install'
                CHECK (action IN ('install', 'update', 'remove')),
  agent_cli   TEXT NOT NULL
                CHECK (agent_cli IN ('opencode','hermes','command-code')),
  api_key_id  TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','claimed','completed','failed')),
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  claimed_at  TEXT,
  finished_at TEXT,
  FOREIGN KEY (machine_id) REFERENCES machines(id) ON DELETE CASCADE
);
CREATE INDEX idx_runtime_events_machine ON runtime_events(machine_id, status);
CREATE INDEX idx_runtime_events_status ON runtime_events(status, created_at);

DROP TABLE runtime_events_old;
