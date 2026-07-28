-- Seed script for local dev D1 database.
-- Run: wrangler d1 execute lexa-db --local --file=scripts/seed-dev.sql
-- This is idempotent: it resets seed project data and re-inserts edge-case-rich mocks.

-- ============================================================
-- Projects
-- ============================================================
INSERT OR REPLACE INTO projects (id, name, slug, description, github_repo)
VALUES
  ('10000000-0000-0000-0000-000000000000', 'Empty Project', 'empty', 'Project with no columns, tasks, or wiki pages.', NULL),
  ('20000000-0000-0000-0000-000000000000', 'Tasks Only', 'tasks-only', 'Has tasks but no wiki.', NULL),
  ('507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Emberfall2', 'emberfall2', 'Full game project with columns, swimlanes, tasks, and wiki.', 'studio/emberfall');

-- ============================================================
-- Tasks-only project: reset + seed
-- ============================================================
DELETE FROM tasks WHERE project_id = '20000000-0000-0000-0000-000000000000';
DELETE FROM swimlanes WHERE project_id = '20000000-0000-0000-0000-000000000000';
DELETE FROM columns WHERE project_id = '20000000-0000-0000-0000-000000000000';
DELETE FROM wiki_pages WHERE project_id = '20000000-0000-0000-0000-000000000000';

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('21000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000000', 'Backlog', 0, '#6b7280', NULL, '[]', NULL),
  ('21000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000000', 'In Progress', 1, '#3b82f6', 2, '[]', NULL);

INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, assignee, position, github_issue_id, github_issue_number, github_repo, github_synced_state)
VALUES
  ('25000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000000', '21000000-0000-0000-0000-000000000000', NULL, 'Orphaned idea task', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"A task without much detail."}]}]}', 'low', 'task', NULL, 'a0', NULL, NULL, NULL, NULL),
  ('25000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000000', '21000000-0000-0000-0000-000000000001', NULL, 'WIP edge case', '{"type":"doc","content":[]}', 'medium', 'task', 'dev1', 'a0', NULL, NULL, NULL, NULL),
  ('25000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000000', '21000000-0000-0000-0000-000000000001', NULL, 'At WIP limit', '{"type":"doc","content":[]}', 'medium', 'task', 'dev2', 'a1', NULL, NULL, NULL, NULL);

-- ============================================================
-- Emberfall2 full project: reset + seed
-- ============================================================
DELETE FROM tasks WHERE project_id = '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea';
DELETE FROM swimlanes WHERE project_id = '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea';
DELETE FROM columns WHERE project_id = '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea';
DELETE FROM wiki_pages WHERE project_id = '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea';

INSERT INTO columns (id, project_id, name, position, color, wip_limit, required_fields, github_state)
VALUES
  ('30000000-0000-0000-0000-000000000000', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Todo', 0, '#6b7280', NULL, '[]', NULL),
  ('30000000-0000-0000-0000-000000000001', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'In Progress', 1, '#3b82f6', 3, '["assignee"]', NULL),
  ('30000000-0000-0000-0000-000000000002', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Review', 2, '#f59e0b', 2, '["description","assignee"]', NULL),
  ('30000000-0000-0000-0000-000000000003', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Done', 3, '#10b981', NULL, '[]', 'closed'),
  ('30000000-0000-0000-0000-000000000004', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Blocked', 4, '#ef4444', NULL, '[]', NULL);

INSERT INTO swimlanes (id, project_id, name, description, position)
VALUES
  ('40000000-0000-0000-0000-000000000000', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Core', 'Current sprint — furnace tilemap & combat', 0),
  ('40000000-0000-0000-0000-000000000001', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Art', 'Previous sprint — cleanup and polish', 1),
  ('40000000-0000-0000-0000-000000000002', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Audio', '', 2);

INSERT INTO tasks (id, project_id, column_id, swimlane_id, title, description, priority, type, assignee, position, github_issue_id, github_issue_number, github_repo, github_synced_state)
VALUES
  ('60000000-0000-0000-0000-000000000000', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000000', 'Design combat core loop', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Core combat feels and timing."}]}]}', 'high', 'feature', 'al', 'a0', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000001', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000000', 'Fix memory leak in projectile pool', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Pooling bug under high load."}]}]}', 'urgent', 'bug', 'dev1', 'a1', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000002', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000000', 'Write unit tests for damage formula', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Missing coverage for edge cases."}]}]}', 'medium', 'task', 'qa1', 'a2', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000003', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000001', 'Create fire enemy sprite sheet', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Animated sprite for fire wisp."}]}]}', 'medium', 'asset', 'bob', 'a3', 'gh_issue_3', 42, 'studio/emberfall', 'open'),
  ('60000000-0000-0000-0000-000000000004', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000002', 'Compose boss battle theme', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Epic orchestral theme for final boss."}]}]}', 'low', 'asset', 'carol', 'a4', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000005', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000000', 'Empty description task', '{"type":"doc","content":[]}', 'low', 'task', NULL, 'a5', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000006', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000000', 'Unassigned urgent bug', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Critical crash on startup."}]}]}', 'urgent', 'bug', NULL, 'a6', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000007', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000000', 'Task in review', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Ready for review, has description and assignee."}]}]}', 'high', 'feature', 'dev1', 'a0', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000008', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000000', 'Second review task', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Review queue at limit."}]}]}', 'medium', 'task', 'dev2', 'a1', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000009', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000000', 'Completed task', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Already shipped."}]}]}', 'medium', 'task', 'dev1', 'a0', NULL, NULL, NULL, NULL),
  ('60000000-0000-0000-0000-000000000010', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', '30000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000000', 'Blocked task', '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Waiting for upstream art."}]}]}', 'high', 'task', 'pm1', 'a0', NULL, NULL, NULL, NULL);

-- ============================================================
-- Wiki pages for Emberfall2: nested 3 levels, empty page
-- ============================================================
INSERT INTO wiki_pages (id, project_id, title, slug, content, content_text, parent_id, position)
VALUES
  ('70000000-0000-0000-0000-000000000000', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Game Design Doc', 'game-design-doc', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Game Design Doc"}]},{"type":"paragraph","content":[{"type":"text","text":"Master document describing Emberfall’s core pillars, target audience, and game loops."}]}]}', 'Game Design Doc\nMaster document describing Emberfall’s core pillars, target audience, and game loops.', NULL, 0),
  ('70000000-0000-0000-0000-000000000001', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Combat System', 'combat-system', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Combat System"}]},{"type":"paragraph","content":[{"type":"text","text":"Emberfall’s combat revolves around four elemental affinities: Fire, Ice, Earth, and Wind."}]}]}', 'Combat System\nEmberfall’s combat revolves around four elemental affinities: Fire, Ice, Earth, and Wind.', '70000000-0000-0000-0000-000000000000', 0),
  ('70000000-0000-0000-0000-000000000002', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Melee Framework', 'melee-framework', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Melee Framework"}]},{"type":"paragraph","content":[{"type":"text","text":"Close-range combat timing, hitstop, and combo windows."}]}]}', 'Melee Framework\nClose-range combat timing, hitstop, and combo windows.', '70000000-0000-0000-0000-000000000001', 0),
  ('70000000-0000-0000-0000-000000000003', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Elemental Damage', 'elemental-damage', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Elemental Damage"}]},{"type":"paragraph","content":[{"type":"text","text":"Resistance matrix and status effects for each element."}]}]}', 'Elemental Damage\nResistance matrix and status effects for each element.', '70000000-0000-0000-0000-000000000001', 1),
  ('70000000-0000-0000-0000-000000000004', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Boss Patterns', 'boss-patterns', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Boss Patterns"}]},{"type":"paragraph","content":[{"type":"text","text":"Phases, tells, and vulnerability windows for major bosses."}]}]}', 'Boss Patterns\nPhases, tells, and vulnerability windows for major bosses.', '70000000-0000-0000-0000-000000000001', 2),
  ('70000000-0000-0000-0000-000000000005', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Level Design', 'level-design', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Level Design"}]},{"type":"paragraph","content":[{"type":"text","text":"World layout, encounter pacing, and tutorialization."}]}]}', 'Level Design\nWorld layout, encounter pacing, and tutorialization.', '70000000-0000-0000-0000-000000000000', 1),
  ('70000000-0000-0000-0000-000000000006', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Art Direction', 'art-direction', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Art Direction"}]},{"type":"paragraph","content":[{"type":"text","text":"Color palette, character silhouettes, and environment mood."}]}]}', 'Art Direction\nColor palette, character silhouettes, and environment mood.', NULL, 1),
  ('70000000-0000-0000-0000-000000000007', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Sound & Music', 'sound-and-music', '{"type":"doc","content":[{"type":"heading","attrs":{"level":1},"content":[{"type":"text","text":"Sound & Music"}]},{"type":"paragraph","content":[{"type":"text","text":"Adaptive music system and sound effect prioritization."}]}]}', 'Sound & Music\nAdaptive music system and sound effect prioritization.', NULL, 2),
  ('70000000-0000-0000-0000-000000000008', '507f1faf-5e10-4fe0-a6d5-dbf0b680c4ea', 'Empty Page', 'empty-page', '{"type":"doc","content":[]}', '', NULL, 3);
