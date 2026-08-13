import { Effect } from "effect";
import { MilestoneService } from "../../services/milestone.service";
import { resolveProject, resolveMilestone } from "../resolve";
import type { Actor } from "../../../shared/types";

export const tool = {
  name: "restore_milestone",
  description: "Restore an archived milestone. Brings the milestone back only — its sprints restore individually. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      milestone: { type: "string", description: "Milestone name (case-insensitive)" },
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
      const actor: Actor = { kind: "agent", label: "mcp", userId: auth?.userId ?? null };
      const { milestone: restored } = yield* milestoneService.restore(actor, milestone.id);
      return {
        message: `Restored milestone "${restored.name}"`,
      };
    }),
};
