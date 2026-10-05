-- 0025_columns_done_flag_backfill.sql — one-time is_done repair for pre-fix projects.
--
-- The create path now flags the canonical done column (LX-131) so milestone and
-- sprint progress count completed tasks. Projects created before that fix carry
-- `columns.is_done = 0` on the default template's "Done" column, so their
-- `tasks_done` counters read 0 forever. Backfill the flag for those projects.
--
-- A single value UPDATE — no DDL, no table rebuild, no FK interaction — so it
-- applies identically under the Bun runner (foreign_keys=OFF) and the
-- Workers/D1 runner (foreign_keys=ON).
--
-- Guarded two ways: only projects with NO flagged column are touched (a project
-- that already marked its own done column is left alone), and only the canonical
-- "Done" name — matched case- and space-insensitively. Idempotent by
-- construction: after the first apply every touched project has a flagged
-- column, so a re-run matches nothing.
UPDATE columns SET is_done = 1
WHERE lower(trim(name)) = 'done'
  AND project_id NOT IN (SELECT project_id FROM columns WHERE is_done = 1);
