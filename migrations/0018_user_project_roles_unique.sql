-- 0018_user_project_roles_unique.sql — one role row per (user, project).
--
-- De-dup first: keep the admin row when both exist (the ORDER BY role read
-- path already resolves 'admin' first). Then the unique index makes the
-- one-role invariant enforceable; D1 cannot rebuild the PK (no ALTER), so an
-- index is the D1-safe shape.
DELETE FROM user_project_roles
 WHERE role = 'member'
   AND EXISTS (
     SELECT 1 FROM user_project_roles AS admin_row
      WHERE admin_row.user_id = user_project_roles.user_id
        AND admin_row.project_id = user_project_roles.project_id
        AND admin_row.role = 'admin'
   );
CREATE UNIQUE INDEX ux_user_project_roles_user_project
  ON user_project_roles(user_id, project_id);
