import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { resolveProject, resolveColumn, resolveSwimlane } from "../resolve";
import { resolveFieldOptionId, optionLabel } from "../field-options";
import { markdownToDoc } from "../../../shared/markdown";
import type { Swimlane, Column, Actor } from "../../../shared/types";

export const tool = {
  name: "create_task",
  description: "Create a new task in a project. Pass column/swimlane by name (case-insensitive), not UUID. priority/type are LABELS from the project's field-config (call get_project to list them); case-insensitive; omitted → first option. Returns a TaskSummary (no description — use get_task for full details).",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug (e.g. 'emberfall')" },
      column: { type: "string", description: "Column name (case-insensitive, e.g. 'In Progress')" },
      title: { type: "string", description: "Task title" },
      description: { type: "string", description: "Task description in Markdown" },
      priority: { type: "string", description: "Priority label from the project's field-config (default: first option)" },
      type: { type: "string", description: "Type label from the project's field-config (default: first option)" },
      assignees: { type: "array", items: { type: "string" }, description: "Assignee names" },
      swimlane: { type: "string", description: "Swimlane name (case-insensitive). Omitted → task lands in the project's Backlog lane" },
      dueAt: { type: "string", description: "Task due date (YYYY-MM-DD), must not be later than the swimlane's due date" },
    },
    required: ["project", "column", "title"],
  },
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const column = yield* resolveColumn(project.id, args.column);
      const swimlane = args.swimlane
        ? yield* resolveSwimlane(project.id, args.swimlane)
        : null;

      const description = args.description
        ? markdownToDoc(args.description)
        : undefined;

      const priority = yield* resolveFieldOptionId(project.id, "priority", args.priority);
      if (!priority) {
        const repo = yield* FieldConfigRepo;
        const opts = yield* repo.findPrioritiesByProject(project.id);
        return yield* Effect.fail({
          code: "INVALID_OPTION",
          message: `Unknown priority '${args.priority}'. Available priorities: ${opts.map((o) => o.label).join(", ")}`,
          details: { availablePriorities: opts.map((o) => o.label) },
        });
      }
      const type = yield* resolveFieldOptionId(project.id, "type", args.type);
      if (!type) {
        const repo = yield* FieldConfigRepo;
        const opts = yield* repo.findTypesByProject(project.id);
        return yield* Effect.fail({
          code: "INVALID_OPTION",
          message: `Unknown type '${args.type}'. Available types: ${opts.map((o) => o.label).join(", ")}`,
          details: { availableTypes: opts.map((o) => o.label) },
        });
      }

      const taskService = yield* TaskService;
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      const { task } = yield* taskService.create(actor, {
        projectId: project.id,
        columnId: column.id,
        swimlaneId: swimlane?.id,
        title: args.title,
        description,
        priority: priority.id,
        type: type.id,
        assignees: args.assignees ?? [],
        dueAt: args.dueAt === "" ? null : args.dueAt,
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

      const configRepo = yield* FieldConfigRepo;
      const config = yield* configRepo.findByProject(project.id);

      return {
        id: task.id,
        title: task.title,
        column: taskColumn.name,
        swimlane: taskSwimlane?.name ?? null,
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
        dueAt: task.dueAt,
        updatedAt: task.updatedAt,
      };
    }),
};
