import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { optionLabel } from "../field-options";
import type { Swimlane, Column, Actor } from "../../../shared/types";

export const tool = {
  name: "archive_task",
  description: "Archive a task by UUID. Archived tasks disappear from the board (they keep their column/position and can be restored). Idempotent. Returns TaskSummary.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID to archive" },
    },
    required: ["taskId"],
  },
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      const { task } = yield* taskService.archive(actor, args.taskId);

      const columnRepo = yield* ColumnRepo;
      let column: Column = { name: "unknown" } as Column;
      const colResult = yield* columnRepo.findById(task.columnId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.succeed({ name: "unknown" } as Column))
      );
      column = colResult;

      const swimlaneRepo = yield* SwimlaneRepo;
      let swimlane: Swimlane | null = null;
      if (task.swimlaneId) {
        const eff = swimlaneRepo.findById(task.swimlaneId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        );
        swimlane = yield* eff;
      }

      const configRepo = yield* FieldConfigRepo;
      const config = yield* configRepo.findByProject(task.projectId);

      return {
        id: task.id,
        title: task.title,
        column: column.name,
        swimlane: swimlane?.name ?? null,
        priority: optionLabel(config.priorities, task.priority),
        type: optionLabel(config.types, task.type),
        priorityId: task.priority,
        typeId: task.type,
        assignees: task.assignees,
        githubIssues: task.githubs.map(g => ({
          number: g.issueNumber,
          repo: g.repo,
          url: g.url,
          outOfSync: g.outOfSync,
        })),
        archivedAt: task.archivedAt,
        updatedAt: task.updatedAt,
      };
    }),
};
