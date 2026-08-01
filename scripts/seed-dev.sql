-- Seed script for local dev database.
-- Run: bun run setup  (or: sqlite3 data/lexa.db < scripts/seed-dev.sql)
-- Idempotent — deletes old seed rows then re-inserts.

-- ============================================================
-- API Keys — for local MCP testing
-- ============================================================
DELETE FROM api_keys WHERE id LIKE 'seed-%';

-- Raw key: lxk_devseed000000000000000000000000000
-- Usage: Authorization: Bearer lxk_devseed000000000000000000000000000
INSERT INTO api_keys (id, name, key_hash, created_at)
VALUES ('seed-key-01', 'dev-local', '5924df2b48817e5557d6ffff89c997306f5dad1d679563891bc7e61ae6ff8722', datetime('now'));

-- ============================================================
-- Users — beyond migration default admin
-- ============================================================
DELETE FROM user_project_roles WHERE user_id IN (SELECT id FROM users WHERE email IN ('dev1@lexa.local', 'dev2@lexa.local', 'qa@lexa.local', 'artist@lexa.local', 'composer@lexa.local', 'pm@lexa.local'));
DELETE FROM users WHERE email IN ('dev1@lexa.local', 'dev2@lexa.local', 'qa@lexa.local', 'artist@lexa.local', 'composer@lexa.local', 'pm@lexa.local');

INSERT INTO users (id, email, name, role)
VALUES
  ('seed-user-01', 'dev1@lexa.local', 'Dev One', 'member'),
  ('seed-user-02', 'dev2@lexa.local', 'Dev Two', 'member'),
  ('seed-user-03', 'qa@lexa.local', 'QA Lead', 'member'),
  ('seed-user-04', 'artist@lexa.local', 'Artist Bob', 'member'),
  ('seed-user-05', 'composer@lexa.local', 'Carol Music', 'member'),
  ('seed-user-06', 'pm@lexa.local', 'PM Alex', 'admin');

-- ============================================================
-- Projects — 4 projects covering empty, minimal, and full
-- ============================================================
-- Delete tasks BEFORE options: tasks FK-reference option rows, so removing
-- an option with live tasks would violate the FK (RESTRICT default).
DELETE FROM tasks WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM priority_options WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM type_options WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM wiki_page_revisions WHERE page_id IN (SELECT id FROM wiki_pages WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall')));
DELETE FROM wiki_pages WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM swimlanes WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM columns WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM user_project_roles WHERE project_id IN (SELECT id FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall'));
DELETE FROM projects WHERE slug IN ('empty','blank','tasks-only','emberfall');

INSERT OR IGNORE INTO projects (id, name, slug, description, github_repo)
VALUES
  ('seed-proj-empty', 'Empty Project', 'empty', 'No columns, no tasks, no wiki — validates truly empty project rendering.', NULL),
  ('seed-proj-blank', 'Blank Board', 'blank', 'Has columns and swimlanes but zero tasks — validates empty board state.', NULL),
  ('seed-proj-minimal', 'Tasks Only', 'tasks-only', 'Has columns and tasks but no wiki and no swimlanes.', NULL),
  ('seed-proj-full', 'Emberfall', 'emberfall', 'Full game project with columns, swimlanes, tasks, wiki, GitHub links, and rich descriptions.', 'studio/emberfall');

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

INSERT INTO swimlanes (id, project_id, name, description, position)
VALUES
  ('seed-sw-bl-0', 'seed-proj-blank', 'Current Sprint', '', 0),
  ('seed-sw-bl-1', 'seed-proj-blank', 'Backlog', 'Future work goes here.', 1);

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
INSERT INTO swimlanes (id, project_id, name, description, position)
VALUES ('seed-sw-min-0', 'seed-proj-minimal', 'Default', '', 0);

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
-- Emberfall full project
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

INSERT INTO swimlanes (id, project_id, name, description, position)
VALUES
  ('seed-sw-f-0', 'seed-proj-full', 'Core', 'Current sprint — furnace tilemap, combat system, AI pathfinding overhaul, boss arena mechanics, lava shader polish.', 0),
  ('seed-sw-f-1', 'seed-proj-full', 'Art', 'Character sprites and environment tiles.', 1),
  ('seed-sw-f-2', 'seed-proj-full', 'Audio', '', 2);

-- Tasks — 15 tasks with assignees via junction table
INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, position, github_issue_id, github_issue_number, github_repo, github_synced_state)
VALUES
  ('seed-task-f-01', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Critical crash on level 3 load',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Game hard-crashes when entering the furnace zone. "},{"type":"text","marks":[{"type":"bold"}],"text":"100% repro rate"},{"type":"text","text":" on all platforms."}]},{"type":"paragraph","content":[{"type":"text","text":"Stack trace points to tilemap chunk loader."}]}]}',
   'seed-prio-full-0', 'seed-type-full-1', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-02', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Design combat core loop',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Combat Core Loop Design"}]},{"type":"paragraph","content":[{"type":"text","text":"Define the timing, hitstop, and feel for melee combat."}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Attack wind-up: 8 frames"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Hitstop on connect: 3 frames"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Combo window: 12 frames after last hit"}]}]}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-03', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-1',
   'Create fire enemy sprite sheet',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Animated sprite for fire wisp enemy. 4 directions, 6 frames each."}]}]}',
   'seed-prio-full-2', 'seed-type-full-3', 'a2', 'github_issue_42', 42, 'studio/emberfall', 'open'),

  ('seed-task-f-04', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-0',
   'Empty description task', '{"type":"doc","content":[]}',
   'seed-prio-full-3', 'seed-type-full-2', 'a3', NULL, NULL, NULL, NULL),

  ('seed-task-f-05', 'seed-proj-full', 'seed-col-f-0', 'seed-sw-f-2',
   'Compose boss battle theme',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Epic orchestral theme for the final boss. 2-3 minute loop."}]}]}',
   'seed-prio-full-3', 'seed-type-full-3', 'a4', NULL, NULL, NULL, NULL),

  ('seed-task-f-06', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-0',
   'Fix memory leak in projectile pool',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Pooling system leaks under high fire rate (>30 projectiles/sec)."}]},{"type":"codeBlock","attrs":{"language":"cpp"},"content":[{"type":"text","text":"// Current problematic code\nif (pool.size() > MAX_POOL) {\n    pool.back()->Die();  // callback re-triggers returnToPool!\n    pool.pop_back();\n}"}]},{"type":"paragraph","content":[{"type":"text","text":"Solution: orphan the projectile first, then trigger Die() outside the pool lock."}]}]}',
   'seed-prio-full-0', 'seed-type-full-1', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-07', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-1',
   'Implement character shadow rendering',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Dynamic blob shadows that scale with distance from light source."}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-08', 'seed-proj-full', 'seed-col-f-1', 'seed-sw-f-0',
   'Refactor tilemap chunk boundary logic',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Current chunk boundary detection is O(n*m). Needs spatial hash."}]}]}',
   'seed-prio-full-2', 'seed-type-full-2', 'a2', NULL, NULL, NULL, NULL),

  ('seed-task-f-09', 'seed-proj-full', 'seed-col-f-2', 'seed-sw-f-0',
   'Damage formula with elemental resistances',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"Review Checklist"}]},{"type":"taskList","content":[{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Fire resistance caps at 75%"}]}]},{"type":"taskItem","attrs":{"checked":true},"content":[{"type":"paragraph","content":[{"type":"text","text":"Ice slow scales with INT"}]}]},{"type":"taskItem","attrs":{"checked":false},"content":[{"type":"paragraph","content":[{"type":"text","text":"Add tests for resistance overflow"}]}]}]}]}',
   'seed-prio-full-1', 'seed-type-full-0', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-10', 'seed-proj-full', 'seed-col-f-2', 'seed-sw-f-2',
   'Audio crackling on looping tracks',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"WAV header parse skips last 4 samples, causing pop at loop point."}]}]}',
   'seed-prio-full-2', 'seed-type-full-1', 'a1', 'github_issue_99', 99, 'studio/emberfall', 'closed'),

  ('seed-task-f-11', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-0',
   'Player movement with analog stick',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Full analog movement with acceleration curves. Shipped in v0.3."}]}]}',
   'seed-prio-full-2', 'seed-type-full-0', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-12', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-1',
   'Export tile asset sheets to 4x atlas', '{"type":"doc","content":[]}',
   'seed-prio-full-3', 'seed-type-full-2', 'a1', NULL, NULL, NULL, NULL),

  ('seed-task-f-13', 'seed-proj-full', 'seed-col-f-3', 'seed-sw-f-2',
   'Footstep SFX sets for 5 terrain types',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Stone, wood, grass, sand, water. Each 8 variants."}]}]}',
   'seed-prio-full-2', 'seed-type-full-3', 'a2', 'github_issue_77', 77, 'studio/emberfall', 'closed'),

  ('seed-task-f-14', 'seed-proj-full', 'seed-col-f-4', 'seed-sw-f-0',
   'Integrate new furnace tilemap',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Waiting for art to deliver final tile sheets (ETA next sprint)."}]},{"type":"paragraph","content":[{"type":"text","text":"All code is ready — just need assets."}]}]}',
   'seed-prio-full-1', 'seed-type-full-2', 'a0', NULL, NULL, NULL, NULL),

  ('seed-task-f-15', 'seed-proj-full', 'seed-col-f-4', 'seed-sw-f-0',
   'Unblocked but no owner', '{"type":"doc","content":[]}',
   'seed-prio-full-2', 'seed-type-full-1', 'a1', NULL, NULL, NULL, NULL);

INSERT INTO task_assignees (task_id, user_name)
VALUES
  ('seed-task-f-02', 'alex'),
  ('seed-task-f-03', 'artist_bob'),
  ('seed-task-f-05', 'carol'),
  ('seed-task-f-06', 'dev1'),
  ('seed-task-f-07', 'artist_bob'),
  ('seed-task-f-08', 'dev2'),
  ('seed-task-f-09', 'dev1'),
  ('seed-task-f-10', 'carol'),
  ('seed-task-f-11', 'dev1'),
  ('seed-task-f-13', 'carol'),
  ('seed-task-f-14', 'dev2');

-- GitHub issue links via junction table
INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state)
VALUES
  ('seed-task-f-03', 'github_issue_42', 42, 'studio/emberfall', 'open'),
  ('seed-task-f-10', 'github_issue_99', 99, 'studio/emberfall', 'closed'),
  ('seed-task-f-13', 'github_issue_77', 77, 'studio/emberfall', 'closed');

-- ============================================================
-- Wiki pages — 9 pages: 2 root, 3 siblings under GDD, 2 under Combat, 1 empty, 1 standalone
-- ============================================================
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position)
VALUES
  ('seed-wiki-00', 'seed-proj-full',
   'Game Design Doc', 'game-design-doc',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Emberfall Game Design Document"}]},{"type":"paragraph","content":[{"type":"text","text":"A 2D action-adventure set in a world where elemental magic has been corrupted. The player wields four elemental affinities — "},{"type":"text","marks":[{"type":"bold"}],"text":"Fire, Ice, Earth, Wind"},{"type":"text","text":" — to restore balance."}]},{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Core Pillars"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Elemental combat with rock-paper-scissors resistances"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Metroidvania-style ability-gated exploration"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Story-driven with branching dialogue"}]}]}]}]}',
   'Emberfall Game Design Document\nA 2D action-adventure set in a world where elemental magic has been corrupted. The player wields four elemental affinities — Fire, Ice, Earth, Wind — to restore balance.\nCore Pillars\nElemental combat with rock-paper-scissors resistances\nMetroidvania-style ability-gated exploration\nStory-driven with branching dialogue',
   NULL, 0),

  ('seed-wiki-01', 'seed-proj-full',
   'Art Direction', 'art-direction',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Color palette: warm oranges and deep blues. Character silhouettes must be readable at 4x zoom-out. Environment mood shifts from bright overworld to dark furnace."}]}]}',
   'Art Direction\nColor palette: warm oranges and deep blues. Character silhouettes must be readable at 4x zoom-out. Environment mood shifts from bright overworld to dark furnace.',
   NULL, 1),

  ('seed-wiki-02', 'seed-proj-full',
   'Combat System', 'combat-system',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Combat Design"}]},{"type":"paragraph","content":[{"type":"text","text":"Emberfall combat revolves around four elemental affinities. Each enemy has a "},{"type":"text","marks":[{"type":"bold"}],"text":"primary weakness"},{"type":"text","text":" that deals 2x damage, and a "},{"type":"text","marks":[{"type":"bold"}],"text":"resistance"},{"type":"text","text":" that deals 0.5x."}]}]}',
   'Combat Design\nEmberfall combat revolves around four elemental affinities. Each enemy has a primary weakness that deals 2x damage, and a resistance that deals 0.5x.',
   'seed-wiki-00', 0),

  ('seed-wiki-03', 'seed-proj-full',
   'Melee Framework', 'melee-framework',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Close-range combat timing: 8f wind-up, 3f hitstop, 12f combo window."}]},{"type":"codeBlock","attrs":{"language":"gdscript"},"content":[{"type":"text","text":"enum AttackPhase { WINDUP, ACTIVE, RECOVERY }"}]}]}',
   'Melee Framework\nClose-range combat timing: 8f wind-up, 3f hitstop, 12f combo window.\nenum AttackPhase { WINDUP, ACTIVE, RECOVERY }',
   'seed-wiki-02', 0),

  ('seed-wiki-04', 'seed-proj-full',
   'Elemental Damage Matrix', 'elemental-damage',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Resistance matrix:"}]},{"type":"bulletList","content":[{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Fire > Ice (+50%)"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#ef4444"}}],"text":" BURN status"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Ice > Earth (+50%)"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#3b82f6"}}],"text":" FREEZE status"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Earth > Wind (+50%)"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#10b981"}}],"text":" STUN status"}]}]},{"type":"listItem","content":[{"type":"paragraph","content":[{"type":"text","text":"Wind > Fire (+50%)"},{"type":"text","marks":[{"type":"textStyle","attrs":{"color":"#f59e0b"}}],"text":" DISPLACE status"}]}]}]}]}',
   'Elemental Damage Matrix\nResistance matrix:\nFire > Ice (+50%) BURN status\nIce > Earth (+50%) FREEZE status\nEarth > Wind (+50%) STUN status\nWind > Fire (+50%) DISPLACE status',
   'seed-wiki-02', 1),

  ('seed-wiki-05', 'seed-proj-full',
   'Level Design', 'level-design',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"World layout: 5 major zones connected by the central Furnace hub. Each zone introduces one new ability and ends with a boss."}]}]}',
   'Level Design\nWorld layout: 5 major zones connected by the central Furnace hub. Each zone introduces one new ability and ends with a boss.',
   'seed-wiki-00', 1),

  ('seed-wiki-06', 'seed-proj-full',
   'Narrative Outline', 'narrative-outline',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Three-act structure with branching at the midpoint based on player choices. Key NPCs: the Forgemaster, the Ember Witch, and the Silent King."}]}]}',
   'Narrative Outline\nThree-act structure with branching at the midpoint based on player choices. Key NPCs: the Forgemaster, the Ember Witch, and the Silent King.',
   'seed-wiki-00', 2),

  ('seed-wiki-07', 'seed-proj-full',
   'Sound & Music', 'sound-and-music',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Adaptive music system: layer intensity tracks based on combat state. Zone themes crossfade seamlessly. SFX prioritization: combat > UI feedback > ambient."}]}]}',
   'Sound & Music\nAdaptive music system: layer intensity tracks based on combat state. Zone themes crossfade seamlessly. SFX prioritization: combat > UI feedback > ambient.',
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
   'Game Design Doc', 'game-design-doc',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Initial draft of the GDD."}]}]}',
   'Initial draft of the GDD.',
   'manual', datetime('now', '-5 days')),
  ('seed-rev-01', 'seed-wiki-00',
   'Game Design Doc', 'game-design-doc',
   '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Emberfall Game Design Document"}]},{"type":"paragraph","content":[{"type":"text","text":"A 2D action-adventure set in a world where elemental magic has been corrupted."}]}]}',
   'Emberfall Game Design Document\nA 2D action-adventure set in a world where elemental magic has been corrupted.',
   'manual', datetime('now', '-3 days')),
  ('seed-rev-02', 'seed-wiki-02',
   'Combat System', 'combat-system',
   '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Draft combat notes — work in progress."}]}]}',
   'Draft combat notes — work in progress.',
   'autosave', datetime('now', '-1 day'));
