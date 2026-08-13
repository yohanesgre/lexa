import { Effect } from "effect";
import { MilestoneService } from "../../services/milestone.service";
import { resolveProject, resolveMilestone } from "../resolve";
import type { Actor } from "../../../shared/types";

export const tool = {
  name: "archive_milestone",
  description: "Archive a milestone. One transaction: the milestone, its sprints, and their live tasks are archived (one archived activity row per task). Idempotent. Admin only.",
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
      const { milestone: archived, activity } = yield* milestoneService.archive(actor, milestone.id);
      return {
        message: `Archived milestone "${archived.name}" (${activity.length} tasks archived)`,
      };
    }),
};
