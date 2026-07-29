import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { docToMarkdown, markdownToDoc } from "../../../shared/markdown";
import type { Swimlane, Column } from "../../../shared/types";

export const tool = {
  name: "update_task",
  description: "Update task fields. description takes Markdown (full replace). assignee: explicit null clears. Returns TaskDetail.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      title: { type: "string", description: "New title" },
      description: { type: "string", description: "New description in Markdown (full replace)" },
      priority: { type: "string", enum: ["urgent", "high", "medium", "low"] },
      type: { type: "string", enum: ["feature", "bug", "task", "asset"] },
      assignee: { type: "string", description: "Assignee name (null to clear)" },
    },
    required: ["taskId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const descriptionDoc = args.description !== undefined
        ? markdownToDoc(args.description)
        : undefined;

      const task = yield* taskService.update(args.taskId, {
        title: args.title,
        description: descriptionDoc as any,
        priority: args.priority,
        type: args.type,
        assignee: args.assignee !== undefined ? args.assignee : undefined,
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
