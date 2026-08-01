import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { docToMarkdown } from "../../../shared/markdown";
import { optionLabel } from "../field-options";
import type { Swimlane, Column } from "../../../shared/types";

export const tool = {
  name: "get_task",
  description: "Get full task details including description (as Markdown). Use after list_tasks to read specific tasks.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
    },
    required: ["taskId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const task = yield* taskService.getById(args.taskId);

      const configRepo = yield* FieldConfigRepo;
      const config = yield* configRepo.findByProject(task.projectId);

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
