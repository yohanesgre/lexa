-- Wizard "Minimal" sample data — one starter project that demonstrates the
-- core workflow (move tasks, WIP limit, done column) without extra users.
-- Run by the setup wizard (POST /api/setup/seed { flavor: "minimal" }).
-- Keys are written explicitly: wizard seeding is not followed by the
-- boot-time backfillTaskKeys pass. GS prefix = generateTaskKey("getting-started").
-- Idempotent — deletes old seed rows then re-inserts.

DELETE FROM task_assignees WHERE task_id IN (SELECT id FROM tasks WHERE project_id = 'seed-proj-start');
DELETE FROM tasks WHERE project_id = 'seed-proj-start';
DELETE FROM priority_options WHERE project_id = 'seed-proj-start';
DELETE FROM type_options WHERE project_id = 'seed-proj-start';
DELETE FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE project_id = 'seed-proj-start');
DELETE FROM wiki_pages WHERE project_id = 'seed-proj-start';
DELETE FROM swimlanes WHERE project_id = 'seed-proj-start';
DELETE FROM columns WHERE project_id = 'seed-proj-start';
DELETE FROM projects WHERE id = 'seed-proj-start';

INSERT INTO projects (id, name, slug, description, team_id, key, next_task_number)
VALUES ('seed-proj-start', 'Getting Started', 'getting-started',
  'A starter project showing the core Lexa workflow: move tasks across columns, respect WIP limits, and keep notes in the wiki.',
  NULL, 'GS', 5);

INSERT INTO priority_options (id, project_id, label, color, position) VALUES
  ('seed-prio-gs-0', 'seed-proj-start', 'Urgent', '#FF4444', 0),
  ('seed-prio-gs-1', 'seed-proj-start', 'High', '#F0C040', 1),
  ('seed-prio-gs-2', 'seed-proj-start', 'Medium', '#22D3EE', 2),
  ('seed-prio-gs-3', 'seed-proj-start', 'Low', '#6B6560', 3);

INSERT INTO type_options (id, project_id, label, color, position) VALUES
  ('seed-type-gs-0', 'seed-proj-start', 'Feature', '#4ADE80', 0),
  ('seed-type-gs-1', 'seed-proj-start', 'Bug', '#FF4444', 1),
  ('seed-type-gs-2', 'seed-proj-start', 'Task', '#22D3EE', 2),
  ('seed-type-gs-3', 'seed-proj-start', 'Asset', '#F472B6', 3);

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('seed-col-gs-0', 'seed-proj-start', 'Backlog', 0, '#6b7280', NULL, '[]', NULL),
  ('seed-col-gs-1', 'seed-proj-start', 'In Progress', 1, '#3b82f6', 3, '["assignee"]', 'open'),
  ('seed-col-gs-2', 'seed-proj-start', 'Done', 2, '#10b981', NULL, '[]', 'closed');

-- tasks.swimlane_id is NOT NULL — the Backlog swimlane is the default.
INSERT INTO swimlanes (id, project_id, name, description, position, kind)
VALUES ('seed-sw-gs-0', 'seed-proj-start', 'Backlog', '', 0, 'backlog');

INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, key, number)
VALUES
  ('seed-task-gs-1', 'seed-proj-start', 'seed-col-gs-0', 'seed-sw-gs-0',
   'Explore the board',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Drag this card to "},{"type":"text","marks":[{"type":"bold"}],"text":"In Progress"},{"type":"text","text":" to start working on it. Columns order the flow; drag cards between them to update status."}]}]}',
   'seed-prio-gs-2', 'seed-type-gs-2', 'a0', 'GS-1', 1),

  ('seed-task-gs-2', 'seed-proj-start', 'seed-col-gs-0', 'seed-sw-gs-0',
   'Invite your team',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Open "},{"type":"text","marks":[{"type":"bold"}],"text":"Workspace settings"},{"type":"text","text":" to create a team and send invite links. Members only see projects their team owns."}]}]}',
   'seed-prio-gs-1', 'seed-type-gs-2', 'a1', 'GS-2', 2),

  ('seed-task-gs-3', 'seed-proj-start', 'seed-col-gs-1', 'seed-sw-gs-0',
   'Learn WIP limits',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"In Progress has a WIP limit of 3. Try moving a fourth task in — the move is rejected until something leaves the column."}]}]}',
   'seed-prio-gs-2', 'seed-type-gs-0', 'a0', 'GS-3', 3),

  ('seed-task-gs-4', 'seed-proj-start', 'seed-col-gs-1', 'seed-sw-gs-0',
   'Write your first task',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Create a task with the + button on any column. Descriptions are rich text: headings, lists, code, images."}]}]}',
   'seed-prio-gs-3', 'seed-type-gs-0', 'a1', 'GS-4', 4),

  ('seed-task-gs-5', 'seed-proj-start', 'seed-col-gs-2', 'seed-sw-gs-0',
   'Finish the setup wizard',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"You already did this one. Done columns can be mapped to GitHub so linked issues close automatically."}]}]}',
   'seed-prio-gs-2', 'seed-type-gs-2', 'a0', 'GS-5', 5);

INSERT INTO task_assignees (task_id, user_name)
VALUES
  ('seed-task-gs-3', 'you'),
  ('seed-task-gs-4', 'you');

INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position)
VALUES
  ('seed-wiki-gs-0', 'seed-proj-start',
   'Using Lexa', 'using-lexa',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Daily flow"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Plan: keep next work in Backlog, ordered by priority."}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Do: pull one card into In Progress — the WIP limit keeps focus."}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Ship: drag to Done when it ships."}]}]}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Where things live"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Board: drag-and-drop kanban with swimlanes."}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Wiki: nested pages like this one for living docs."}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"GitHub: link a repo in project settings to sync issues."}]}]}]}]}',
   'Daily flow\nPlan: keep next work in Backlog, ordered by priority.\nDo: pull one card into In Progress — the WIP limit keeps focus.\nShip: drag to Done when it ships.\nWhere things live\nBoard: drag-and-drop kanban with swimlanes.\nWiki: nested pages like this one for living docs.\nGitHub: link a repo in project settings to sync issues.',
   NULL, 0);
