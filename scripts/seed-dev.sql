-- Seed script for local dev database.
-- Run: bun run setup  (or: sqlite3 data/lexa.db < scripts/seed-dev.sql)
-- Idempotent — deletes old seed rows then re-inserts.

-- ============================================================
-- Users — beyond migration default admin
-- ============================================================
DELETE FROM user_project_roles WHERE user_id IN (SELECT id FROM users WHERE email IN ('dev1@lexa.local', 'dev2@lexa.local', 'qa@lexa.local', 'designer@lexa.local', 'writer@lexa.local', 'pm@lexa.local'));
DELETE FROM users WHERE email IN ('dev1@lexa.local', 'dev2@lexa.local', 'qa@lexa.local', 'designer@lexa.local', 'writer@lexa.local', 'pm@lexa.local');

INSERT INTO users (id, email, name, role)
VALUES
  ('seed-user-01', 'dev1@lexa.local', 'Dev One', 'member'),
  ('seed-user-02', 'dev2@lexa.local', 'Dev Two', 'member'),
  ('seed-user-03', 'qa@lexa.local', 'QA Lead', 'member'),
  ('seed-user-04', 'designer@lexa.local', 'Designer Bob', 'member'),
  ('seed-user-05', 'writer@lexa.local', 'Carol Writer', 'member'),
  ('seed-user-06', 'pm@lexa.local', 'PM Alex', 'admin');

-- ============================================================
-- Projects — 4 projects covering empty, minimal, and full
-- ============================================================
-- Delete tasks BEFORE options: tasks FK-reference option rows, so removing
-- an option with live tasks would violate the FK (RESTRICT default).
DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM priority_options WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM type_options WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus')));
DELETE FROM wiki_pages WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM swimlanes WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM columns WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM user_project_roles WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus'));
DELETE FROM projects WHERE slug IN ('empty','blank','tasks-only','nimbus');

INSERT OR IGNORE INTO projects (id, name, slug, description, github_repo)
VALUES
  ('seed-proj-empty', 'Empty Project', 'empty', 'No columns, no tasks, no wiki — validates truly empty project rendering.', NULL),
  ('seed-proj-blank', 'Blank Board', 'blank', 'Has columns and swimlanes but zero tasks — validates empty board state.', NULL),
  ('seed-proj-minimal', 'Tasks Only', 'tasks-only', 'Has columns and tasks but no wiki and no swimlanes.', NULL),
  ('seed-proj-full', 'Nimbus', 'nimbus', 'Full product project with columns, swimlanes, tasks, wiki, GitHub links, and rich descriptions.', 'acme/nimbus');

-- ============================================================
-- Task field options — seed the default 4+4 per project
-- ============================================================
INSERT INTO priority_options (id, project_id, label, color, position) VALUES
  ('seed-prio-full-0', 'seed-proj-full', 'Urgent', '#FF4444', 0),
  ('seed-prio-full-1', 'seed-proj-full', 'High', '#F0C040', 1),
  ('seed-prio-full-2', 'seed-proj-full', 'Medium', '#22D3EE', 2),
  ('seed-prio-full-3', 'seed-proj-full', 'Low', '#6B6560', 3),
  ('seed-prio-min-0', 'seed-proj-minimal', 'Urgent', '#FF4444', 0),
  ('seed-prio-min-1', 'seed-proj-minimal', 'High', '#F0C040', 1),
  ('seed-prio-min-2', 'seed-proj-minimal', 'Medium', '#22D3EE', 2),
  ('seed-prio-min-3', 'seed-proj-minimal', 'Low', '#6B6560', 3),
  ('seed-prio-bl-0', 'seed-proj-blank', 'Urgent', '#FF4444', 0),
  ('seed-prio-bl-1', 'seed-proj-blank', 'High', '#F0C040', 1),
  ('seed-prio-bl-2', 'seed-proj-blank', 'Medium', '#22D3EE', 2),
  ('seed-prio-bl-3', 'seed-proj-blank', 'Low', '#6B6560', 3),
  ('seed-prio-em-0', 'seed-proj-empty', 'Urgent', '#FF4444', 0),
  ('seed-prio-em-1', 'seed-proj-empty', 'High', '#F0C040', 1),
  ('seed-prio-em-2', 'seed-proj-empty', 'Medium', '#22D3EE', 2),
  ('seed-prio-em-3', 'seed-proj-empty', 'Low', '#6B6560', 3);

INSERT INTO type_options (id, project_id, label, color, position) VALUES
  ('seed-type-full-0', 'seed-proj-full', 'Feature', '#4ADE80', 0),
  ('seed-type-full-1', 'seed-proj-full', 'Bug', '#FF4444', 1),
  ('seed-type-full-2', 'seed-proj-full', 'Task', '#22D3EE', 2),
  ('seed-type-full-3', 'seed-proj-full', 'Asset', '#F472B6', 3),
  ('seed-type-min-0', 'seed-proj-minimal', 'Feature', '#4ADE80', 0),
  ('seed-type-min-1', 'seed-proj-minimal', 'Bug', '#FF4444', 1),
  ('seed-type-min-2', 'seed-proj-minimal', 'Task', '#22D3EE', 2),
  ('seed-type-min-3', 'seed-proj-minimal', 'Asset', '#F472B6', 3),
  ('seed-type-bl-0', 'seed-proj-blank', 'Feature', '#4ADE80', 0),
  ('seed-type-bl-1', 'seed-proj-blank', 'Bug', '#FF4444', 1),
  ('seed-type-bl-2', 'seed-proj-blank', 'Task', '#22D3EE', 2),
  ('seed-type-bl-3', 'seed-proj-blank', 'Asset', '#F472B6', 3),
  ('seed-type-em-0', 'seed-proj-empty', 'Feature', '#4ADE80', 0),
  ('seed-type-em-1', 'seed-proj-empty', 'Bug', '#FF4444', 1),
  ('seed-type-em-2', 'seed-proj-empty', 'Task', '#22D3EE', 2),
  ('seed-type-em-3', 'seed-proj-empty', 'Asset', '#F472B6', 3);

-- ============================================================
-- User-project roles
-- ============================================================
DELETE FROM user_project_roles WHERE project_id LIKE 'seed-%';

INSERT INTO user_project_roles (user_id, role, project_id)
VALUES
  ('seed-user-01', 'member', 'seed-proj-full'),
  ('seed-user-02', 'member', 'seed-proj-full'),
  ('seed-user-03', 'member', 'seed-proj-full'),
  ('seed-user-04', 'member', 'seed-proj-full'),
  ('seed-user-05', 'member', 'seed-proj-full'),
  ('seed-user-06', 'admin', 'seed-proj-full'),
  ('seed-user-06', 'admin', 'seed-proj-minimal');

-- ============================================================
-- Blank Board project — columns + swimlanes but ZERO tasks
-- ============================================================
DELETE FROM tasks WHERE project_id = 'seed-proj-blank';
DELETE FROM swimlanes WHERE project_id = 'seed-proj-blank';
DELETE FROM columns WHERE project_id = 'seed-proj-blank';

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('seed-col-bl-0', 'seed-proj-blank', 'Backlog', 0, '#6b7280', NULL, '[]', NULL),
  ('seed-col-bl-1', 'seed-proj-blank', 'In Progress', 1, '#3b82f6', 3, '["assignee"]', 'open'),
  ('seed-col-bl-2', 'seed-proj-blank', 'Done', 2, '#10b981', NULL, '[]', 'closed');

INSERT INTO swimlanes (id, project_id, name, description, position, kind)
VALUES
  ('seed-sw-bl-0', 'seed-proj-blank', 'Backlog', 'Future work goes here.', 0, 'backlog'),
  ('seed-sw-bl-1', 'seed-proj-blank', 'Current Sprint', '', 1, 'milestone');

-- ============================================================
-- Tasks Only project — 3 columns, 5 tasks, no swimlanes
-- ============================================================
DELETE FROM tasks WHERE project_id = 'seed-proj-minimal';
DELETE FROM swimlanes WHERE project_id = 'seed-proj-minimal';
DELETE FROM columns WHERE project_id = 'seed-proj-minimal';

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('seed-col-min-0', 'seed-proj-minimal', 'Backlog', 0, '#6b7280', NULL, '[]', NULL),
  ('seed-col-min-1', 'seed-proj-minimal', 'In Progress', 1, '#3b82f6', 2, '["assignee"]', NULL),
  ('seed-col-min-2', 'seed-proj-minimal', 'Done', 2, '#10b981', NULL, '[]', 'closed');

-- tasks.swimlane_id is NOT NULL since migration 0007 — give the project a default swimlane
INSERT INTO swimlanes (id, project_id, name, description, position, kind)
VALUES ('seed-sw-min-0', 'seed-proj-minimal', 'Backlog', '', 0, 'backlog');

INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position)
VALUES
  ('seed-task-min-0', 'seed-proj-minimal', 'seed-col-min-0', 'seed-sw-min-0', 'Unassigned backlog bug', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A bug sitting in backlog with no owner."}]}]}', 'seed-prio-min-1', 'seed-type-min-1', 'Zz'),
  ('seed-task-min-1', 'seed-proj-minimal', 'seed-col-min-0', 'seed-sw-min-0', 'Low priority feature idea', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Nice to have someday."}]}]}', 'seed-prio-min-3', 'seed-type-min-0', 'a0'),
  ('seed-task-min-2', 'seed-proj-minimal', 'seed-col-min-1', 'seed-sw-min-0', 'WIP task with assignee', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Should be movable since assignee field present."}]}]}', 'seed-prio-min-2', 'seed-type-min-2', 'a0'),
  ('seed-task-min-3', 'seed-proj-minimal', 'seed-col-min-1', 'seed-sw-min-0', 'At WIP limit second task', '{"type":"doc","content":[]}', 'seed-prio-min-2', 'seed-type-min-2', 'a1'),
  ('seed-task-min-4', 'seed-proj-minimal', 'seed-col-min-2', 'seed-sw-min-0', 'Shipped feature', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Done and gone."}]}]}', 'seed-prio-min-2', 'seed-type-min-0', 'a0');

INSERT INTO task_assignees (task_id, user_name)
VALUES
  ('seed-task-min-2', 'dev1'),
  ('seed-task-min-3', 'dev2'),
  ('seed-task-min-4', 'dev1');

-- ============================================================
-- Nimbus full project
-- ============================================================
DELETE FROM tasks WHERE project_id = 'seed-proj-full';
DELETE FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE project_id = 'seed-proj-full');
DELETE FROM wiki_pages WHERE project_id = 'seed-proj-full';
DELETE FROM swimlanes WHERE project_id = 'seed-proj-full';
DELETE FROM columns WHERE project_id = 'seed-proj-full';

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('seed-col-f-0', 'seed-proj-full', 'Todo', 0, '#6b7280', NULL, '[]', NULL),
  ('seed-col-f-1', 'seed-proj-full', 'In Progress', 1, '#3b82f6', 3, '["assignee"]', 'open'),
  ('seed-col-f-2', 'seed-proj-full', 'Review', 2, '#f59e0b', 2, '["description","assignee"]', 'open'),
  ('seed-col-f-3', 'seed-proj-full', 'Done', 3, '#10b981', NULL, '[]', 'closed'),
  ('seed-col-f-4', 'seed-proj-full', 'Blocked', 4, '#ef4444', NULL, '["description"]', NULL);

INSERT INTO swimlanes (id, project_id, name, description, position, kind)
VALUES
  ('seed-sw-f-0', 'seed-proj-full', 'Backlog', '', 0, 'backlog'),
  ('seed-sw-f-1', 'seed-proj-full', 'Core', 'Current sprint — dashboard refactor, auth flows, API pagination, billing UI, onboarding polish.', 1, 'milestone'),
  ('seed-sw-f-2', 'seed-proj-full', 'Design', 'UI mockups and design tokens.', 2, 'milestone'),
  ('seed-sw-f-3', 'seed-proj-full', 'QA', '', 3, 'milestone');

-- Tasks — 15 tasks with assignees via junction table
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, github_issue_id, github_issue_number, github_repo, github_synced_state)
VALUES
  ('seed-task-f-01', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Critical crash on dashboard load',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"App crashes when opening the dashboard with a large board. "},{"type":"text","marks":[{"type":"bold"}],"text":"100% repro rate"},{"type":"text","text":" on all browsers."}]},{"type":"paragraph","content":[{"type":"text","text":"Stack trace points to the task-list virtualizer."}]}]}',
   'seed-prio-full-0', 'seed-type-full-1', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-02', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Design onboarding flow',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Onboarding Flow Design"}]},{"type":"paragraph","content":[{"type":"text","text":"Define the welcome sequence from signup to first board."}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Welcome email: 1 day after signup"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"First-project wizard: 3 steps"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Invite prompt: after first task created"}]}]}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-03', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-1',
   'Create landing page illustrations',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Illustrations for the marketing page hero and feature sections. 2 variants each."}]}]}',
   'seed-prio-full-2', 'seed-type-full-3', 'a2', 'github_issue_42', 42, 'acme/nimbus', 'open'),

  ('seed-task-f-04', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Empty description task', '{"type":"doc","content":[]}',
   'seed-prio-full-3', 'seed-type-full-2', 'a3', NULL, NULL, NULL, NULL),

  ('seed-task-f-05', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-2',
   'Write launch blog post',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Announcement post covering the kanban board, wiki, and AI assistant. 800-1200 words."}]}]}',
   'seed-prio-full-3', 'seed-type-full-3', 'a4', NULL, NULL, NULL, NULL),

  ('seed-task-f-06', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-0',
   'Fix memory leak in notification queue',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Queue grows unbounded under high activity (>30 events/sec)."}]},{"type":"codeBlock","attrs":{"language":"ts"},"content":[{"type":"text","text":"// Current problematic code\nif (queue.size() > MAX_QUEUE) {\n    queue.back()->Retire();  // callback re-triggers enqueue!\n    queue.pop_back();\n}"}]},{"type":"paragraph","content":[{"type":"text","text":"Solution: orphan the entry first, then Retire() outside the queue lock."}]}]}',
   'seed-prio-full-0', 'seed-type-full-1', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-07', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-1',
   'Implement keyboard navigation',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Full arrow-key board navigation with screen-reader labels."}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-08', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-0',
   'Refactor task-list pagination',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Current offset pagination is O(n) on large boards. Needs cursor-based keyset pagination."}]}]}',
   'seed-prio-full-2', 'seed-type-full-2', 'a2', NULL, NULL, NULL, NULL),

  ('seed-task-f-09', 'seed-proj-full', 'seed-col-f-2', 'seed-sw-f-0',
   'Role-based access control',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Review Checklist"}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Admins can invite members"}]}]},{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Members can edit tasks and wiki pages"}]}]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Add tests for role escalation"}]}]}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-10', 'seed-proj-full', 'seed-col-f-2', 'seed-sw-f-2',
   'Email links broken in shared sessions',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Invite links 404 when opened in a second session — token parser skips the last 4 chars."}]}]}',
   'seed-prio-full-2', 'seed-type-full-1', 'a1', 'github_issue_99', 99, 'acme/nimbus', 'closed'),

  ('seed-task-f-11', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-0',
   'Dark mode toggle',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Full theme switch with persisted preference. Shipped in v0.3."}]}]}',
   'seed-prio-full-2', 'seed-type-full-0', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-12', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-1',
   'Export OpenAPI 3.1 spec', '{"type":"doc","content":[]}',
   'seed-prio-full-3', 'seed-type-full-2', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-13', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-2',
   'Design system color tokens',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Neutral, brand, success, warning, danger. Each 8 shades."}]}]}',
   'seed-prio-full-2', 'seed-type-full-3', 'a2', 'github_issue_77', 77, 'acme/nimbus', 'closed'),

  ('seed-task-f-14', 'seed-proj-full', 'seed-col-f-4', 'seed-sw-f-0',
   'Integrate new billing provider',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Waiting for the payments team to deliver sandbox keys (ETA next sprint)."}]},{"type":"paragraph","content":[{"type":"text","text":"All code is ready — just need credentials."}]}]}',
   'seed-prio-full-1', 'seed-type-full-2', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-15', 'seed-proj-full', 'seed-col-f-4', 'seed-sw-f-0',
   'Unblocked but no owner', '{"type":"doc","content":[]}',
   'seed-prio-full-2', 'seed-type-full-1', 'a1', NULL, NULL, NULL, NULL);

INSERT INTO task_assignees (task_id, user_name)
VALUES
  ('seed-task-f-02', 'alex'),
  ('seed-task-f-03', 'designer_bob'),
  ('seed-task-f-05', 'carol'),
  ('seed-task-f-06', 'dev1'),
  ('seed-task-f-07', 'designer_bob'),
  ('seed-task-f-08', 'dev2'),
  ('seed-task-f-09', 'dev1'),
  ('seed-task-f-10', 'carol'),
  ('seed-task-f-11', 'dev1'),
  ('seed-task-f-13', 'designer_bob'),
  ('seed-task-f-14', 'dev2');

-- GitHub issue links via junction table
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state)
VALUES
  ('seed-task-f-03', 'github_issue_42', 42, 'acme/nimbus', 'open'),
  ('seed-task-f-10', 'github_issue_99', 99, 'acme/nimbus', 'closed'),
  ('seed-task-f-13', 'github_issue_77', 77, 'acme/nimbus', 'closed');

-- ============================================================
-- Wiki pages — 9 pages: 2 root, 3 siblings under Product Overview, 2 under Auth, 1 empty, 1 standalone
-- ============================================================
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position)
VALUES
  ('seed-wiki-00', 'seed-proj-full',
   'Product Overview', 'product-overview',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Nimbus Product Overview"}]},{"type":"paragraph","content":[{"type":"text","text":"A web app for small teams to plan and ship. "},{"type":"text","marks":[{"type":"bold"}],"text":"Plan, track, and ship"},{"type":"text","text":" — boards, docs, and AI help in one place."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Core Pillars"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Kanban boards with swimlanes and WIP limits"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Nested wiki for living documentation"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"AI-assisted task writing and review"}]}]}]}]}',
   'Nimbus Product Overview\nA web app for small teams to plan and ship. Plan, track, and ship — boards, docs, and AI help in one place.\nCore Pillars\nKanban boards with swimlanes and WIP limits\nNested wiki for living documentation\nAI-assisted task writing and review',
   NULL, 0),

  ('seed-wiki-01', 'seed-proj-full',
   'Design System', 'design-system',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Color tokens: warm neutrals with a blue brand accent. Component spacing uses a 4px grid. Dark mode ships with the v0.3 theme refresh."}]}]}',
   'Design System\nColor tokens: warm neutrals with a blue brand accent. Component spacing uses a 4px grid. Dark mode ships with the v0.3 theme refresh.',
   NULL, 1),

  ('seed-wiki-02', 'seed-proj-full',
   'Auth & Permissions', 'auth-permissions',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Access Model"}]},{"type":"paragraph","content":[{"type":"text","text":"Nimbus access revolves around two roles. Admins can "},{"type":"text","marks":[{"type":"bold"}],"text":"invite members"},{"type":"text","text":" and manage projects; members can "},{"type":"text","marks":[{"type":"bold"}],"text":"edit tasks and wiki pages"},{"type":"text","text":"."}]}]}',
   'Access Model\nNimbus access revolves around two roles. Admins can invite members and manage projects; members can edit tasks and wiki pages.',
   'seed-wiki-00', 0),

  ('seed-wiki-03', 'seed-proj-full',
   'RBAC Model', 'rbac-model',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Role checks: admin can delete projects, member can move tasks."}]},{"type":"codeBlock","attrs":{"language":"ts"},"content":[{"type":"text","text":"enum Role { ADMIN, MEMBER }"}]}]}',
   'RBAC Model\nRole checks: admin can delete projects, member can move tasks.\nenum Role { ADMIN, MEMBER }',
   'seed-wiki-02', 0),

  ('seed-wiki-04', 'seed-proj-full',
   'Permission Matrix', 'permission-matrix',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Who can do what:"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Admin: full access"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#ef4444"}}],"text":" OWN"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Member: tasks + wiki edit"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#3b82f6"}}],"text":" EDIT"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Guest: read-only (planned)"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#10b981"}}],"text":" VIEW"}]}]}]}]}',
   'Permission Matrix\nWho can do what:\nAdmin: full access OWN\nMember: tasks + wiki edit EDIT\nGuest: read-only (planned) VIEW',
   'seed-wiki-02', 1),

  ('seed-wiki-05', 'seed-proj-full',
   'API Design', 'api-design',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"REST surface: /api/projects, /api/projects/:slug/tasks. Pagination is cursor-based; errors follow the error catalog."}]}]}',
   'API Design\nREST surface: /api/projects, /api/projects/:slug/tasks. Pagination is cursor-based; errors follow the error catalog.',
   'seed-wiki-00', 1),

  ('seed-wiki-06', 'seed-proj-full',
   'Roadmap', 'roadmap',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Quarterly themes with mid-quarter re-planning. Key milestones: open beta, GitHub sync GA, mobile layout."}]}]}',
   'Roadmap\nQuarterly themes with mid-quarter re-planning. Key milestones: open beta, GitHub sync GA, mobile layout.',
   'seed-wiki-00', 2),

  ('seed-wiki-07', 'seed-proj-full',
   'Brand & Voice', 'brand-and-voice',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Tone: direct, human, no hype. Docs voice matches the product: short sentences, concrete examples."}]}]}',
   'Brand & Voice\nTone: direct, human, no hype. Docs voice matches the product: short sentences, concrete examples.',
   NULL, 2),

  ('seed-wiki-08', 'seed-proj-full',
   'Empty Page', 'empty-page',
   '{"type":"doc","content":[]}',
   '',
   'seed-wiki-01', 0);

-- ============================================================
-- Wiki page revisions — simulate edit history for 3 pages
-- ============================================================
INSERT INTO wiki_page_revisions (id, page_id, title, slug, content, content_text, save_type, created_at)
VALUES
  ('seed-rev-00', 'seed-wiki-00',
   'Product Overview', 'product-overview',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Initial draft of the product overview."}]}]}',
   'Initial draft of the product overview.',
   'manual', datetime('now', '-5 days')),
  ('seed-rev-01', 'seed-wiki-00',
   'Product Overview', 'product-overview',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Nimbus Product Overview"}]},{"type":"paragraph","content":[{"type":"text","text":"A web app for small teams to plan and ship."}]}]}',
   'Nimbus Product Overview\nA web app for small teams to plan and ship.',
   'manual', datetime('now', '-3 days')),
  ('seed-rev-02', 'seed-wiki-02',
   'Auth & Permissions', 'auth-permissions',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Draft access notes — work in progress."}]}]}',
   'Draft access notes — work in progress.',
   'autosave', datetime('now', '-1 day'));
