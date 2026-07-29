import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { resolveProject, resolveColumn, resolveSwimlane } from "../resolve";
import { markdownToDoc } from "../../../shared/markdown";
import type { Swimlane, Column } from "../../../shared/types";

export const tool = {
  name: "create_task",
  description: "Create a new task in a project. Pass column/swimlane by name (case-insensitive), not UUID. Priority defaults to 'medium', type defaults to 'task'. Returns a TaskSummary (no description — use get_task for full details).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug (e.g. 'emberfall')" },
      column: { type: "string", description: "Column name (case-insensitive, e.g. 'In Progress')" },
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description in Markdown" },
      priority: { type: "string", enum: ["urgent", "high", "medium", "low"], description: "Priority (default: medium)" },
      type: { type: "string", enum: ["feature", "bug", "task", "asset"], description: "Task type (default: task)" },
      assignee: { type: "string", description: "Assignee name" },
      swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
    },
    required: ["project", "column", "title"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const column = yield* resolveColumn(project.id, args.column);
      let swimlane: Swimlane | null = null;
      if (args.swimlane) {
        swimlane = yield* resolveSwimlane(project.id, args.swimlane);
      }

      const description = args.description
        ? markdownToDoc(args.description)
        : undefined;

      const taskService = yield* TaskService;
      const task = yield* taskService.create({
        projectId: project.id,
        columnId: column.id,
        swimlaneId: swimlane?.id ?? null,
        title: args.title,
        description,
        priority: args.priority ?? "medium",
        type: args.type ?? "task",
        assignee: args.assignee ?? null,
      });

      const columnRepo = yield* ColumnRepo;
      let taskColumn: Column = column;
      const colResult = yield* columnRepo.findById(task.columnId).pipe(
        Effect.catchTag("RowNotFound", () => Effect.succeed(column))
      );
      taskColumn = colResult;

      const swimlaneRepo = yield* SwimlaneRepo;
      let taskSwimlane: Swimlane | null = null;
      if (task.swimlaneId) {
        const eff = swimlaneRepo.findById(task.swimlaneId).pipe(
          Effect.catchTag("RowNotFound", () => Effect.succeed(null))
        );
        taskSwimlane = yield* eff;
      }

      return {
        id: task.id,
        title: task.title,
        column: taskColumn.name,
        swimlane: taskSwimlane?.name ?? null,
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
      };
    }),
};
