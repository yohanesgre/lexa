-- ============================================================
-- 0027 — Forge: agents + skills (replaces the fixed action prompts)
-- ============================================================
-- Agents are named rule bundles (instructions become AGENTS.md in the run
-- dir at claim time); skills are named operation bundles (instructions
-- become .agents/<skill>/SKILL.md). Bindings are M2M. Both are global —
-- the server is the single source of truth, delivered claim-carried.

CREATE TABLE forge_agents (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  instructions TEXT NOT NULL,
  is_builtin  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE forge_agent_skills (
  agent_id TEXT NOT NULL REFERENCES forge_agents(id) ON DELETE CASCADE,
  skill_id TEXT NOT NULL REFERENCES forge_skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);

-- Builtin seeds: "Lexa" (default agent, the Forge identity) and the five
-- original assistant actions as skills, all attached to Lexa.
INSERT INTO forge_agents (id, name, description, instructions, is_builtin) VALUES
  ('lexa', 'Lexa',
   'Default writing assistant — matches the document''s voice, outputs only text.',
   'You are Forge, a writing assistant inside Lexa. You help a game-dev team write task descriptions and wiki pages. You are a text editor, not an agent: you do not call tools, you do not read files, and you do not act on any system. Your whole output is the text you write.',
   1);

INSERT INTO forge_skills (id, name, description, instructions, is_builtin) VALUES
  ('continue', 'Continue',
   'Continue the text naturally from the cursor, matching its style, tone, and structure.',
   'Continue the text below naturally, matching its style, tone, and structure. Output only the continuation, no preamble.',
   1),
  ('rewrite', 'Rewrite',
   'Make the selected text clearer and more concise without changing the meaning.',
   'Rewrite the selected text to be clearer and more concise. Keep the meaning. Keep the same structure and level of detail — tighten the prose, don''t restructure arbitrarily. Output only the rewritten text.',
   1),
  ('summarize', 'Summarize',
   'Condense the selected text into an overview plus key-point bullets.',
   'Summarize the selected text. Lead with a 1–2 sentence overview, then 3–6 bullets of the key points. Keep it tight. Output only the summary.',
   1),
  ('expand', 'Expand',
   'Expand the selected text into more detail, keeping the same voice.',
   'Expand the selected text into more detail, keeping the same voice. Break it into labeled sections with subheadings and add concrete examples or specifics where they help. Output only the expanded text.',
   1),
  ('grammar', 'Fix grammar',
   'Fix grammar, spelling, and punctuation without changing meaning or formatting.',
   'Fix grammar, spelling, and punctuation in the selected text. Do not change meaning, style, or structure — preserve the exact formatting. Output only the corrected text.',
   1);

INSERT INTO forge_agent_skills (agent_id, skill_id) VALUES
  ('lexa', 'continue'), ('lexa', 'rewrite'), ('lexa', 'summarize'), ('lexa', 'expand'), ('lexa', 'grammar');

-- forge_tasks: replace the fixed action enum with agent_id + skill_id
-- (backfill: skill from action, agent -> the builtin 'lexa') + extra_prompt.
-- Rebuild so the new NOT NULL columns carry no leftover defaults. SQLite
-- keeps index names across RENAME, so drop the carried-over index first.
ALTER TABLE forge_tasks RENAME TO forge_tasks_old;
DROP INDEX IF EXISTS idx_forge_tasks_status;

CREATE TABLE forge_tasks (
  id            TEXT PRIMARY KEY,
  runtime_id    TEXT REFERENCES runtimes(id) ON DELETE SET NULL,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('task', 'wiki')),
  document_id   TEXT NOT NULL,
  agent_id      TEXT NOT NULL REFERENCES forge_agents(id),
  skill_id      TEXT NOT NULL REFERENCES forge_skills(id),
  extra_prompt  TEXT NOT NULL DEFAULT '',
  selection     TEXT NOT NULL DEFAULT '',
  doc_context   TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result        TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT,
  finished_at   TEXT
);
CREATE INDEX idx_forge_tasks_status ON forge_tasks(status, created_at);

INSERT INTO forge_tasks (
  id, runtime_id, project_id, document_type, document_id, agent_id, skill_id,
  extra_prompt, selection, doc_context, status, result, error,
  created_at, started_at, finished_at
)
SELECT
  id, runtime_id, project_id, document_type, document_id, 'lexa', action,
  '', selection, doc_context, status, result, error,
  created_at, started_at, finished_at
FROM forge_tasks_old;

DROP TABLE forge_tasks_old;
