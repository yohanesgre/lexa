-- Hearth engine switching + vision (docs/SCHEMA.md — migration 0013).
-- Per-project execution engine for document threads + Generate; freeform chat
-- always runs the herald lane regardless of engine.

ALTER TABLE herald_settings ADD COLUMN engine TEXT NOT NULL DEFAULT 'herald'
  CHECK (engine IN ('herald','blacksmith'));
ALTER TABLE herald_settings ADD COLUMN engine_switcher_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE herald_settings ADD COLUMN primary_supports_images INTEGER NOT NULL DEFAULT 0;
ALTER TABLE herald_settings ADD COLUMN vision_model TEXT;

-- Agent catalog rebinding: the generic 'lexa' entry is retired (id NOT reused);
-- Herald Agent gets a NEW internal id and its FK/junction references are
-- rebound in this same transaction. One-time consequence: existing threads
-- keyed on agentId reset once (continue-vs-fresh sees an unknown agentId).
UPDATE lexa_agents SET id = 'hearth-herald', name = 'Herald Agent',
  instructions = 'You are the Herald Agent, Lexa''s companion project-management assistant. You help teams run their projects: you draft and sharpen task descriptions, requirements, and wiki pages, spot missing details, unclear scope, and weak acceptance criteria, and answer questions about the project. You may read files in your working directory (the project workspace) to ground your writing in the actual repo and docs. You do not write files, run commands, or act on any system — your whole output is the text you write. Match the document''s existing voice and structure. If the linked sources contradict the document, prefer the sources.'
WHERE id = 'lexa';
UPDATE forge_tasks SET agent_id = 'hearth-herald' WHERE agent_id = 'lexa';
UPDATE lexa_agent_skills SET agent_id = 'hearth-herald' WHERE agent_id = 'lexa';

INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES
  ('hearth-blacksmith', 'Blacksmith Agent', '',
   'You are the Blacksmith Agent, a coding agent working inside a persistent project workspace. You implement, refactor, and debug code: read the repository, plan the change, apply it, and verify with builds or tests where possible. Follow the project''s existing conventions and keep changes minimal and focused. When a task is ambiguous, choose the smallest reasonable interpretation and state your assumption in the final summary.',
   1);

-- Junction seeding: Herald Agent offers every builtin skill (OR IGNORE — the
-- rebind above already carried over the rows the old agent had).
INSERT OR IGNORE INTO lexa_agent_skills (agent_id, skill_id)
SELECT 'hearth-herald', id FROM lexa_skills WHERE is_builtin = 1;

-- Blacksmith Agent starts with the spec-quality subset (requirements,
-- definition-of-done, review); deliverables/status/polish are document-polish
-- skills that stay Herald-only.
INSERT INTO lexa_agent_skills (agent_id, skill_id)
SELECT 'hearth-blacksmith', id FROM lexa_skills WHERE id IN ('requirements', 'definition-of-done', 'review');
