import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { resolveColumn } from "../resolve";
import { optionLabel } from "../field-options";
import type { Swimlane, Column } from "../../../shared/types";

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
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const task = yield* taskService.getById(args.taskId);
      const column = yield* resolveColumn(task.projectId, args.column);

      const moved = yield* taskService.move(args.taskId, {
        columnId: column.id,
        swimlaneId: task.swimlaneId,
        beforeTaskId: args.beforeTaskId,
        afterTaskId: args.afterTaskId,
      });

      const columnRepo = yield* ColumnRepo;
      let resultColumn: Column = column;
      const colResult = yield* columnRepo.findById(moved.columnId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.succeed(column))
      );
      resultColumn = colResult;

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
        updatedAt: moved.updatedAt,
      };
    }),
};
