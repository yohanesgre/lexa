-- UI gaps wave 4 — additive columns only (D1-compatible: ADD COLUMN).
-- 1. task_github_issues.issue_title — last-known upstream GitHub issue title.
-- 2. wiki_pages.updated_by — user id of the last save (NULL for legacy rows).
-- 3. runtime_events.team_id — team the setup event binds the runtime to
--    (NULL = global runtime).
ALTER TABLE task_github_issues ADD COLUMN issue_title TEXT;
ALTER TABLE wiki_pages ADD COLUMN updated_by TEXT;
ALTER TABLE runtime_events ADD COLUMN team_id TEXT REFERENCES organization(id) ON DELETE SET NULL;
