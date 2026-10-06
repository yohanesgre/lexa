-- 0027_drop_idx_wiki_project.sql — drop the redundant project-only wiki index.
--
-- UNIQUE(project_id, slug) on wiki_pages (0001_init.sql) has project_id as its
-- leading column, so it already serves every read that filters wiki rows by
-- project_id alone (list, by-slug, revisions, FTS join, MAX(position) probes).
-- idx_wiki_project (project_id) is a second identical-leading-column btree:
-- dead weight on every wiki write and a candidate the planner must weigh.
DROP INDEX IF EXISTS idx_wiki_project;
