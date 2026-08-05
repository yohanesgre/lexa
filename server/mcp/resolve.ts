import { Effect } from "effect";
import { ProjectRepo } from "../repos/project.repo";
import { ColumnRepo } from "../repos/column.repo";
import { SwimlaneRepo } from "../repos/swimlane.repo";
import { TaskRepo } from "../repos/task.repo";
import { ProjectNotFound, ColumnNotFound, SwimlaneNotFound, TaskNotFound } from "../api/errors";
import { DbError } from "../db/database";

export function resolveProject(projectSlug: string) {
  return Effect.gen(function* () {
    const projectRepo = yield* ProjectRepo;
    const project = yield* projectRepo.findBySlug(projectSlug).pipe(
      Effect.catchTag("RowNotFound", () =>
        Effect.gen(function* () {
          const all = yield* projectRepo.list();
          return yield* new ProjectNotFound({
            identifier: projectSlug,
            availableProjects: all.map((p) => p.slug),
          } as any);
        })
      )
    );
    return project;
  });
}

export function resolveColumn(projectId: string, columnName: string) {
  return Effect.gen(function* () {
    const columnRepo = yield* ColumnRepo;
    const columns = yield* columnRepo.findByProject(projectId);
    const column = columns.find(
      (c) => c.name.toLowerCase() === columnName.toLowerCase()
    );
    if (!column) {
      return yield* new ColumnNotFound({
        id: columnName,
        availableColumns: columns.map((c) => c.name),
      } as any);
    }
    return column;
  });
}

export function resolveSwimlane(projectId: string, swimlaneName: string) {
  return Effect.gen(function* () {
    const swimlaneRepo = yield* SwimlaneRepo;
    const swimlanes = yield* swimlaneRepo.findByProject(projectId);
    const swimlane = swimlanes.find(
      (s) => s.name.toLowerCase() === swimlaneName.toLowerCase()
    );
    if (!swimlane) {
      return yield* new SwimlaneNotFound({
        id: swimlaneName,
        availableSwimlanes: swimlanes.map((s) => s.name),
      } as any);
    }
    return swimlane;
  });
}

export function resolveTaskProject(taskId: string) {
  return Effect.gen(function* () {
    const taskRepo = yield* TaskRepo;
    const projectRepo = yield* ProjectRepo;
    const task = yield* taskRepo.findById(taskId).pipe(
      Effect.catchTag("RowNotFound", () => new TaskNotFound({ id: taskId }))
    );
    return yield* projectRepo.findById(task.projectId);
  });
}
