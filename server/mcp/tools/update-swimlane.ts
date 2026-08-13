import { Effect } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject, resolveSwimlane, resolveMilestone } from "../resolve";

export const tool = {
  name: "update_swimlane",
  description: "Update a swimlane's name, description, dates, or milestone. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description" },
      dueAt: { type: "string", description: "Sprint due date (YYYY-MM-DD). Omit to leave unchanged; empty string clears it." },
      startAt: { type: "string", description: "Sprint start date (YYYY-MM-DD). Omit to leave unchanged; empty string clears it." },
      milestone: { type: "string", description: "Milestone name (case-insensitive). Empty string detaches the lane." },
    },
    required: ["project", "swimlane"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }

      const project = yield* resolveProject(args.project);
      const swimlane = yield* resolveSwimlane(project.id, args.swimlane);
      const swimlaneService = yield* SwimlaneService;
      const patch: { name?: string; description?: string; dueAt?: string | null; startAt?: string | null; milestoneId?: string | null } = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.dueAt !== undefined) patch.dueAt = args.dueAt === "" ? null : args.dueAt;
      if (args.startAt !== undefined) patch.startAt = args.startAt === "" ? null : args.startAt;
      if (args.milestone !== undefined) patch.milestoneId = args.milestone === "" ? null : (yield* resolveMilestone(project.id, args.milestone)).id;
      const updated = yield* swimlaneService.update(swimlane.id, patch);

      return {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        position: updated.position,
      };
    }),
};
