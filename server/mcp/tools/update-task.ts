import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { docToMarkdown, markdownToDoc } from "../../../shared/markdown";
import { resolveFieldOptionId, optionLabel } from "../field-options";
import type { Swimlane, Column } from "../../../shared/types";

export const tool = {
  name: "update_task",
  description: "Update task fields. description takes Markdown (full replace). assignees: empty array clears. priority/type are LABELS from the project's field-config (case-insensitive). Returns TaskDetail.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description in Markdown (full replace)" },
      priority: { type: "string", description: "Priority label from the project's field-config" },
      type: { type: "string", description: "Type label from the project's field-config" },
      assignees: { type: "array", items: { type: "string" }, description: "Assignee names (empty array to clear)" },
    },
    required: ["taskId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const descriptionDoc = args.description !== undefined
        ? markdownToDoc(args.description)
        : undefined;

      const configRepo = yield* FieldConfigRepo;
      let priorityId: string | undefined;
      let typeId: string | undefined;

      const existing = yield* taskService.getById(args.taskId).pipe(
        Effect.catchTag("TaskNotFound", () => Effect.fail({ code: "TASK_NOT_FOUND", message: `Task not found: ${args.taskId}` }))
      );
      const config = yield* configRepo.findByProject(existing.projectId);

      if (args.priority !== undefined) {
        const resolved = yield* resolveFieldOptionId(existing.projectId, "priority", args.priority);
        if (!resolved) {
          return yield* Effect.fail({
            code: "INVALID_OPTION",
            message: `Unknown priority '${args.priority}'. Available priorities: ${config.priorities.map((o) => o.label).join(", ")}`,
            details: { availablePriorities: config.priorities.map((o) => o.label) },
          });
        }
        priorityId = resolved.id;
      }
      if (args.type !== undefined) {
        const resolved = yield* resolveFieldOptionId(existing.projectId, "type", args.type);
        if (!resolved) {
          return yield* Effect.fail({
            code: "INVALID_OPTION",
            message: `Unknown type '${args.type}'. Available types: ${config.types.map((o) => o.label).join(", ")}`,
            details: { availableTypes: config.types.map((o) => o.label) },
          });
        }
        typeId = resolved.id;
      }

      const task = yield* taskService.update(args.taskId, {
        title: args.title,
        description: descriptionDoc as any,
        priority: priorityId,
        type: typeId,
        assignees: args.assignees,
      });

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
        updatedAt: task.updatedAt,
        description: docToMarkdown(task.description),
        createdAt: task.createdAt,
      };
    }),
};
