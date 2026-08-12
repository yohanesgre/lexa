import { Effect } from "effect";
import { Sqlite, queryAll, run, DbError, ConstraintViolation, withTx } from "../db/database";
import { ProjectRepoRow, rowToProjectRepo } from "../../shared/db";
import type { ProjectRepo } from "../../shared/types";

export class ProjectReposRepo extends Effect.Service<ProjectReposRepo>()("Lexa/ProjectReposRepo", {
  effect: Effect.gen(function* () {
    const db = yield* Sqlite;

    return {
      listByProject: (projectId: string): Effect.Effect<ProjectRepo[], DbError> =>
        queryAll<ProjectRepoRow>(db, `SELECT * FROM project_repos WHERE project_id = ? ORDER BY repo`, projectId).pipe(
          Effect.map((rows) => rows.map(rowToProjectRepo))
        ),

      listByRepo: (repo: string): Effect.Effect<ProjectRepoRow[], DbError> =>
        queryAll<ProjectRepoRow>(db, `SELECT * FROM project_repos WHERE repo = ?`, repo),

      // Full replace of a project's repo list (PUT semantics). Delete + insert
      // in one transaction; UNIQUE(project_id, repo) guards duplicates.
      replace: (projectId: string, repos: { repo: string; sourceRole: boolean; workspaceRole: boolean }[]): Effect.Effect<void, ConstraintViolation | DbError> =>
        withTx(
          db,
          Effect.gen(function* () {
            yield* run(db, `DELETE FROM project_repos WHERE project_id = ?`, projectId);
            for (const r of repos) {
              yield* run(
                db,
                `INSERT INTO project_repos (id, project_id, repo, source_role, workspace_role) VALUES (?, ?, ?, ?, ?)`,
                crypto.randomUUID(),
                projectId,
                r.repo,
                r.sourceRole ? 1 : 0,
                r.workspaceRole ? 1 : 0
              );
            }
          })
        ),
    };
  }),
}) {}
