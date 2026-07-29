import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { docToMarkdown } from "../../../shared/markdown";
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
        priority: task.priority,
        type: task.type,
        assignee: task.assignee,
        githubIssue: task.github
          ? {
              number: task.github.issueNumber,
              repo: task.github.repo,
              url: task.github.url,
              outOfSync: task.github.outOfSync,
            }
          : null,
        updatedAt: task.updatedAt,
        description: docToMarkdown(task.description),
        createdAt: task.createdAt,
      };
    }),
};
