import { Effect } from "effect";
import { MilestoneService } from "../../services/milestone.service";
import { resolveProject, resolveMilestone } from "../resolve";

export const tool = {
  name: "update_milestone",
  description: "Update a milestone's name, description, or due date. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      milestone: { type: "string", description: "Milestone name (case-insensitive)" },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description" },
      dueAt: { type: "string", description: "Target date (YYYY-MM-DD). Empty string clears." },
    },
    required: ["project", "milestone"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const project = yield* resolveProject(args.project);
      const milestone = yield* resolveMilestone(project.id, args.milestone);
      const milestoneService = yield* MilestoneService;
      const patch: { name?: string; description?: string; dueAt?: string | null } = {};
      if (args.name !== undefined) patch.name = args.name;
      if (args.description !== undefined) patch.description = args.description;
      if (args.dueAt !== undefined) patch.dueAt = args.dueAt === "" ? null : args.dueAt;
      const updated = yield* milestoneService.update(milestone.id, patch);
      return {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        position: updated.position,
        dueAt: updated.dueAt,
        sprintCount: updated.sprintCount,
        archivedSprintCount: updated.archivedSprintCount,
      };
    }),
};
