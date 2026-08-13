import { Effect } from "effect";
import { MilestoneService } from "../../services/milestone.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "create_milestone",
  description: "Create a new milestone in a project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      name: { type: "string", description: "Milestone name" },
      description: { type: "string", description: "Milestone description" },
      dueAt: { type: "string", description: "Target date (YYYY-MM-DD). Empty string clears." },
    },
    required: ["project", "name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const project = yield* resolveProject(args.project);
      const milestoneService = yield* MilestoneService;
      const milestone = yield* milestoneService.create({
        projectId: project.id, name: args.name, description: args.description,
        dueAt: args.dueAt === "" ? null : args.dueAt,
      });
      return { id: milestone.id, name: milestone.name, description: milestone.description, position: milestone.position };
    }),
};
