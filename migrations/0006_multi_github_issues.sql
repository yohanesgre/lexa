-- Migration 0006: Multi-GitHub Issues junction table
-- Replaces inline tasks.github_issue_id/github_issue_number/github_repo/github_synced_state
-- with task_github_issues(task_id, issue_id, issue_number, repo, synced_state).
-- One task -> many GitHub issues.

CREATE TABLE task_github_issues (
  task_id       TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  issue_id      TEXT NOT NULL,
  issue_number  INTEGER NOT NULL,
  repo          TEXT NOT NULL,
  synced_state  TEXT CHECK (synced_state IN ('open','closed')),
  PRIMARY KEY (task_id, issue_id)
);

INSERT INTO task_github_issues (task_id, issue_id, issue_number, repo, synced_state)
SELECT id, github_issue_id, github_issue_number, github_repo, github_synced_state
FROM tasks WHERE github_issue_id IS NOT NULL;

-- Old columns stay on tasks table — unused, zero-cost. D1 doesn't support DROP COLUMN easily.
-- Remove when D1 adds DROP COLUMN support or on next schema rebuild.
