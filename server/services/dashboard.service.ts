import { Effect } from "effect";
import { ProjectRepo } from "../repos/project.repo";
import { ProjectReposRepo } from "../repos/project-repos.repo";
import { ColumnRepo } from "../repos/column.repo";
import { TaskRepo } from "../repos/task.repo";
import type { Dashboard } from "../../shared/types";
import { DbError } from "../db/database";

export class DashboardService extends Effect.Service<DashboardService>()("Lexa/DashboardService", {
  dependencies: [ProjectRepo.Default, ProjectReposRepo.Default, ColumnRepo.Default, TaskRepo.Default],
  effect: Effect.gen(function* () {
    const projectRepo = yield* ProjectRepo;
    const projectReposRepo = yield* ProjectReposRepo;
    const columnRepo = yield* ColumnRepo;
    const taskRepo = yield* TaskRepo;

    return {
      getDashboard: (): Effect.Effect<Dashboard, DbError> =>
        Effect.gen(function* () {
          const projects = yield* projectRepo.list();

          const projectHealths = yield* Effect.forEach(projects, (project) =>
            Effect.gen(function* () {
              const columns = yield* columnRepo.findByProject(project.id);
              const repos = yield* projectReposRepo.listByProject(project.id);
              const [taskCount, urgentCount, syncCount] = yield* Effect.all([
                taskRepo.countByProject(project.id),
                taskRepo.countUrgent(project.id),
                taskRepo.countOutOfSync(project.id),
              ], { concurrency: 3 });

              const wipSegments = yield* Effect.forEach(columns, (column) =>
                Effect.gen(function* () {
                  const count = yield* taskRepo.countByColumn(project.id, column.id);
                  let state: "ok" | "approaching" | "exceeded" | "empty";
                  if (count === 0) {
                    state = "empty";
                  } else if (column.wipLimit !== null && count > column.wipLimit) {
                    state = "exceeded";
                  } else if (column.wipLimit !== null && count >= column.wipLimit) {
                    state = "approaching";
                  } else {
                    state = "ok";
                  }
                  const flex = Math.max(count, 1);
                  return { state, flex };
                })
              );

              let health: "ok" | "approaching" | "exceeded" = "ok";
              if (wipSegments.some((s) => s.state === "exceeded")) {
                health = "exceeded";
              } else if (urgentCount > 0) {
                health = "approaching";
              }

              return {
                project: { ...project, repos },
                taskCount,
                columnCount: columns.length,
                urgentCount,
                syncCount,
                health,
                wipSegments,
              };
            })
          );

          const totalTasks = projectHealths.reduce((sum, p) => sum + p.taskCount, 0);
          const activeProjects = projects.length;
          const wipExceeded = projectHealths.filter((p) => p.health === "exceeded").length;
          const outOfSync = projectHealths.reduce((sum, p) => sum + p.syncCount, 0);

          const [urgentTasks, outOfSyncTasks] = yield* Effect.all([
            taskRepo.findUrgentAcrossAllProjects(50),
            taskRepo.findOutOfSyncAcrossAllProjects(50),
          ], { concurrency: 2 });

          return {
            projects: projectHealths,
            stats: {
              totalTasks,
              activeProjects,
              wipExceeded,
              outOfSync,
            },
            urgentTasks: urgentTasks.map((t) => ({
              id: t.id,
              title: t.title,
              projectName: t.project_name,
              projectSlug: t.project_slug,
              columnName: t.column_name,
              priority: t.priority as "urgent",
            })),
            outOfSyncTasks: outOfSyncTasks.map((t) => ({
              id: t.id,
              title: t.title,
              projectName: t.project_name,
              projectSlug: t.project_slug,
              repo: t.repo,
              issueNumber: t.issue_number,
            })),
          };
        }),
    };
  }),
}) {}
