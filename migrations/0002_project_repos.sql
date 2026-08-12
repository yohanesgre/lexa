-- GitHub repo linking rework: multiple repos per project with roles.

CREATE TABLE project_repos (
  id              TEXT PRIMARY KEY,                          -- UUID
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  repo            TEXT NOT NULL,                             -- "owner/name"
  source_role     INTEGER NOT NULL DEFAULT 0,                -- Forge context + project label
  workspace_role  INTEGER NOT NULL DEFAULT 0,                -- issue link/create/sync
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_project_repos_unique ON project_repos(project_id, repo);
CREATE INDEX idx_project_repos_repo ON project_repos(repo);

-- Migrate legacy projects.github_repo -> row with BOTH roles (it was the issue
-- link target and the only repo of the project).
INSERT OR IGNORE INTO project_repos (id, project_id, repo, source_role, workspace_role)
SELECT lower(hex(randomblob(16))), id, github_repo, 1, 1
FROM projects
WHERE github_repo IS NOT NULL AND github_repo != '';

-- Migrate repos already present in task_github_issues -> workspace role.
-- UNIQUE(project_id, repo) makes this idempotent against the rows above.
INSERT OR IGNORE INTO project_repos (id, project_id, repo, source_role, workspace_role)
SELECT lower(hex(randomblob(16))), t.project_id, tgi.repo, 0, 1
FROM (SELECT DISTINCT task_id, repo FROM task_github_issues) tgi
JOIN tasks t ON t.id = tgi.task_id;

-- Echo columns for asymmetric content sync (push title/body, webhook echo check).
ALTER TABLE task_github_issues ADD COLUMN pushed_title TEXT;
ALTER TABLE task_github_issues ADD COLUMN pushed_body TEXT;
ALTER TABLE task_github_issues ADD COLUMN push_failed INTEGER NOT NULL DEFAULT 0;

-- projects.github_repo replaced by project_repos.
ALTER TABLE projects DROP COLUMN github_repo;
