import { Effect, Either } from "effect";
import { MilestoneService } from "../../services/milestone.service";
import { resolveProject, resolveMilestone } from "../resolve";

export const tool = {
  name: "delete_milestone",
  description: "Delete a milestone. Fails with HAS_CHILDREN while it still has sprints — loosen or reassign them first. Admin only.",
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
      const result = yield* Effect.either(milestoneService.delete(milestone.id));
      if (Either.isLeft(result)) {
        if (result.left._tag === "HasChildren") {
          return {
            isError: true,
            error: { code: "HAS_CHILDREN", message: `Milestone has ${result.left.count} sprint(s) — loosen or reassign them first` },
          };
        }
        return yield* Effect.fail(result.left);
      }
      return { message: `Deleted milestone "${milestone.name}"` };
    }),
};
