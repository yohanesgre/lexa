import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import { ColumnRepo } from "../../repos/column.repo";
import { SwimlaneRepo } from "../../repos/swimlane.repo";
import { FieldConfigRepo } from "../../repos/field-config.repo";
import { resolveProject, resolveColumn, resolveSwimlane } from "../resolve";
import { resolveFieldOptionId, optionLabel } from "../field-options";
import { clampLimit, nextCursor } from "../../../shared/pagination";

export const tool = {
  name: "list_tasks",
  description: "List tasks in a project with optional filters. type is a TYPE LABEL from the project's field-config (case-insensitive). Returns TaskSummary objects (no descriptions — use get_task for full details). Cursor-based pagination; use nextCursor from response to get next page.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      column: { type: "string", description: "Filter by column name (case-insensitive)" },
      swimlane: { type: "string", description: "Filter by swimlane name (case-insensitive)" },
      assignee: { type: "string", description: "Filter by assignee" },
      type: { type: "string", description: "Filter by type label (case-insensitive)" },
      includeArchived: { type: "boolean", description: "Include archived tasks (default false)" },
      limit: { type: "number", description: "Max results (default 50, max 200)" },
      cursor: { type: "string", description: "Pagination cursor from previous response" },
    },
    required: ["project"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const project = yield* resolveProject(args.project);
      const limit = clampLimit(args.limit ?? 50);
      const cursor = args.cursor ?? undefined;

      let columnId: string | undefined;
      if (args.column) {
        const column = yield* resolveColumn(project.id, args.column);
        columnId = column.id;
      }

      let swimlaneId: string | undefined;
      if (args.swimlane) {
        const swimlane = yield* resolveSwimlane(project.id, args.swimlane);
        swimlaneId = swimlane.id;
      }

      let typeId: string | undefined;
      if (args.type) {
        const resolved = yield* resolveFieldOptionId(project.id, "type", args.type);
        if (!resolved) {
          const configRepo = yield* FieldConfigRepo;
          const config = yield* configRepo.findByProject(project.id);
          return yield* Effect.fail({
            code: "INVALID_OPTION",
            message: `Unknown type '${args.type}'. Available types: ${config.types.map((o) => o.label).join(", ")}`,
            details: { availableTypes: config.types.map((o) => o.label) },
          });
        }
        typeId = resolved.id;
      }

      const taskService = yield* TaskService;
      const result = yield* taskService.findByProject(
        project.id,
        {
          columnId,
          swimlaneId,
          assignee: args.assignee,
          type: typeId,
          includeArchived: args.includeArchived === true,
        },
        limit,
        cursor
      );

      const columnRepo = yield* ColumnRepo;
      const columns = yield* columnRepo.findByProject(project.id);
      const columnMap = new Map(columns.map((c) => [c.id, c]));

      const swimlaneRepo = yield* SwimlaneRepo;
      const swimlanes = yield* swimlaneRepo.findByProject(project.id);
      const swimlaneMap = new Map(swimlanes.map((s) => [s.id, s]));

      const configRepo = yield* FieldConfigRepo;
      const config = yield* configRepo.findByProject(project.id);

      const tasks = result.tasks.map((t) => {
        const col = columnMap.get(t.columnId);
        const lane = swimlaneMap.get(t.swimlaneId) ?? null;
        return {
          id: t.id,
          title: t.title,
          column: col?.name ?? "unknown",
          swimlane: lane?.name ?? null,
          priority: optionLabel(config.priorities, t.priority),
          type: optionLabel(config.types, t.type),
          priorityId: t.priority,
          typeId: t.type,
          assignees: t.assignees,
          githubIssues: t.githubs.map(g => ({
                number: g.issueNumber,
                repo: g.repo,
                url: g.url,
                outOfSync: g.outOfSync,
              })),
          archivedAt: t.archivedAt,
          updatedAt: t.updatedAt,
        };
      });

      return {
        tasks,
        nextCursor: result.hasMore ? nextCursor(result.tasks, limit) : null,
      };
    }),
};
