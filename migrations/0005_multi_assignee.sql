CREATE TABLE task_assignees (
  task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_name TEXT NOT NULL,
  PRIMARY KEY (task_id, user_name)
);

INSERT INTO task_assignees (task_id, user_name)
SELECT id, assignee FROM tasks WHERE assignee IS NOT NULL AND assignee != '';

ALTER TABLE tasks DROP COLUMN assignee;
