import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { GitHubService } from "../../services/github.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { resolveColumn } from "../resolve";
import { optionLabel } from "../field-options";
import { TaskNotFound } from "../../api/errors";
import type { Swimlane, Column, Actor } from "../../../shared/types";

export const tool = {
  name: "move_task",
  description: "Move task to a different column. column is the column name (case-insensitive). before/after: UUIDs of neighboring tasks for precise positioning; omit both to append at end. Within-column reorder never fails WIP. Returns TaskSummary.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID to move" },
      column: { type: "string", description: "Target column name (case-insensitive)" },
      beforeTaskId: { type: "string", description: "Place before this task UUID" },
      afterTaskId: { type: "string", description: "Place after this task UUID" },
    },
    required: ["taskId", "column"],
  },
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const task = yield* taskService.getById(args.taskId);
      const column = yield* resolveColumn(task.projectId, args.column);

      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      const { task: moved } = yield* taskService.move(actor, args.taskId, {
        columnId: column.id,
        swimlaneId: task.swimlaneId,
        beforeTaskId: args.beforeTaskId,
        afterTaskId: args.afterTaskId,
      }).pipe(
        // A RowNotFound here is a missing neighbor (the task itself and the
        // column were already resolved above) — REST semantics: TASK_NOT_FOUND.
        Effect.catchTag("RowNotFound", () =>
          new TaskNotFound({ id: args.beforeTaskId ?? args.afterTaskId ?? "" })
        )
      );

      const columnRepo = yield* ColumnRepo;
      let resultColumn: Column = column;
      const colResult = yield* columnRepo.findById(moved.columnId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.succeed(column))
      );
      resultColumn = colResult;

      if (resultColumn.githubState && moved.githubs.length > 0) {
        // Best-effort, non-blocking — mirrors the REST move handler: a GitHub
        // failure never fails the move (echo suppression makes a re-sync
        // idempotent). Log and skip.
        const githubService = yield* GitHubService;
        yield* githubService.syncStateFromLexa(moved.id, resultColumn.githubState).pipe(
          Effect.catchTag("GithubApiError", (e) => Effect.logWarning(`[GitHub] sync failed for task ${moved.id}`, e)),
          Effect.catchTag("DbError", (e) => Effect.logWarning(`[GitHub] sync failed for task ${moved.id}`, e)),
          Effect.catchTag("ConstraintViolation", (e) => Effect.logWarning(`[GitHub] sync failed for task ${moved.id}`, e))
        );
      }

      const swimlaneRepo = yield* SwimlaneRepo;
      let swimlane: Swimlane | null = null;
      if (moved.swimlaneId) {
        const eff = swimlaneRepo.findById(moved.swimlaneId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        );
        swimlane = yield* eff;
      }

      const configRepo = yield* FieldConfigRepo;
      const config = yield* configRepo.findByProject(moved.projectId);

      return {
        id: moved.id,
        title: moved.title,
        column: resultColumn.name,
        swimlane: swimlane?.name ?? null,
        priority: optionLabel(config.priorities, moved.priority),
        type: optionLabel(config.types, moved.type),
        priorityId: moved.priority,
        typeId: moved.type,
        assignees: moved.assignees,
        githubIssues: moved.githubs.map(g => ({
          number: g.issueNumber,
          repo: g.repo,
          url: g.url,
          outOfSync: g.outOfSync,
        })),
        archivedAt: moved.archivedAt,
        updatedAt: moved.updatedAt,
      };
    }),
};
