-- Forge warm sessions: maps one (document, runtime) pair to the agent-side
-- conversation (opencode serve session id) the next task on that document
-- should continue. Written pre-spawn by the daemon (spec §8 step 3); dropped
-- on cancel/timeout (daemon-side) or via the user-facing reset endpoint.
-- runtime_session_id is deliberately agent-agnostic — the runtime session is
-- the agent-side conversation on the machine, never a Lexa session; provider
-- records which CLI owns it so the id stays interpretable without a join to
-- the (deletable) runtimes row. Only opencode writes rows in v1.
-- Agent/skill change → the daemon mints a new session and updates the row
-- (reset semantics, no history rows).
CREATE TABLE forge_sessions (
  document_type   TEXT    NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id     TEXT    NOT NULL,
  runtime_id      TEXT    NOT NULL,
  runtime_session_id TEXT NOT NULL,
  provider        TEXT    NOT NULL CHECK (provider IN ('opencode', 'hermes', 'command-code')),
  agent_id        TEXT    NOT NULL,
  skill_id        TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (document_type, document_id, runtime_id)
);
