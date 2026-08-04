-- Forge builtin reposition: writing assistant → project-management assistant.
-- Repurposes the 5 original writing builtins into a PRD-standard PM skill set
-- (ids renamed to match), adds the Polish builtin, and updates the Lexa agent
-- rules. Idempotent: on fresh installs 0001 already seeds the new ids and
-- content, so the UPDATEs are no-ops and the INSERTs are ignored.
--
-- Renames are children-first (forge_agent_skills, forge_tasks, then
-- forge_skills) so the FK chain stays valid with foreign_keys = ON.

UPDATE forge_agent_skills SET skill_id = 'requirements' WHERE skill_id = 'continue';
UPDATE forge_tasks SET skill_id = 'requirements' WHERE skill_id = 'continue';
UPDATE forge_skills SET id = 'requirements' WHERE id = 'continue';

UPDATE forge_agent_skills SET skill_id = 'deliverables' WHERE skill_id = 'rewrite';
UPDATE forge_tasks SET skill_id = 'deliverables' WHERE skill_id = 'rewrite';
UPDATE forge_skills SET id = 'deliverables' WHERE id = 'rewrite';

UPDATE forge_agent_skills SET skill_id = 'review' WHERE skill_id = 'summarize';
UPDATE forge_tasks SET skill_id = 'review' WHERE skill_id = 'summarize';
UPDATE forge_skills SET id = 'review' WHERE id = 'summarize';

UPDATE forge_agent_skills SET skill_id = 'definition-of-done' WHERE skill_id = 'expand';
UPDATE forge_tasks SET skill_id = 'definition-of-done' WHERE skill_id = 'expand';
UPDATE forge_skills SET id = 'definition-of-done' WHERE id = 'expand';

UPDATE forge_agent_skills SET skill_id = 'status' WHERE skill_id = 'grammar';
UPDATE forge_tasks SET skill_id = 'status' WHERE skill_id = 'grammar';
UPDATE forge_skills SET id = 'status' WHERE id = 'grammar';

UPDATE forge_agents SET
  description = 'Default project assistant — writes and sharpens task descriptions, requirements, and wiki pages.',
  instructions = 'You are Forge, Lexa''s project management assistant. You help teams run their projects: you write task descriptions, requirements, and wiki pages, and you sharpen the team''s documents — spotting missing details, unclear scope, and weak acceptance criteria. You may read files in your working directory (the project workspace) to ground your writing in the actual repo and docs. You do not write files, run commands, or act on any system — your whole output is the text you write. Match the document''s existing voice and structure. If the linked sources contradict the document, prefer the sources.'
WHERE id = 'lexa' AND is_builtin = 1;

UPDATE forge_skills SET
  name = 'Requirements',
  description = 'Write clear, testable requirements for a task.',
  instructions = 'Write only the task''s requirements — what must hold when it''s done. One concrete, verifiable condition per checkbox item (- [ ]). No design proposals or background. Output only the checklist.'
WHERE id = 'requirements' AND is_builtin = 1;

UPDATE forge_skills SET
  name = 'Deliverables',
  description = 'Break a task into deliverables.',
  instructions = 'Split the task into a checklist of deliverables — concrete, actionable outputs. Each must be independently completable. Note dependencies. Output only the checklist.'
WHERE id = 'deliverables' AND is_builtin = 1;

UPDATE forge_skills SET
  name = 'Review',
  description = 'Improve a task''s clarity and completeness like a PM.',
  instructions = 'Review the task like a project manager: fix missing details, unclear scope, weak requirements, and risks. Output the improved full task — not a separate report.'
WHERE id = 'review' AND is_builtin = 1;

UPDATE forge_skills SET
  name = 'Definition of done',
  description = 'Write a Definition of Done checklist for a task.',
  instructions = 'Write a Definition of Done checklist (- [ ]): conditions that must hold before the task counts as complete. Each item concrete and verifiable. Output only the checklist.'
WHERE id = 'definition-of-done' AND is_builtin = 1;

UPDATE forge_skills SET
  name = 'Status',
  description = 'Write a status update: progress, blockers, next steps.',
  instructions = 'Write a status update: what''s done, what''s blocked (and why), what''s next. Be honest; flag risks early. Output only the status update.'
WHERE id = 'status' AND is_builtin = 1;

INSERT OR IGNORE INTO forge_skills (id, name, description, instructions, is_builtin) VALUES
  ('polish', 'Polish',
   'Refine the selected text: clearer, more concise, same meaning.',
   'Polish the selected text: clearer and more concise, keeping the meaning, structure, and level of detail. Output only the polished text.',
   1);

INSERT OR IGNORE INTO forge_agent_skills (agent_id, skill_id) VALUES ('lexa', 'polish');
