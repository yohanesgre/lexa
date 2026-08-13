import { Effect } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject, resolveMilestone } from "../resolve";

export const tool = {
  name: "create_swimlane",
  description: "Create a new sprint swimlane in a project. Optionally attach it to a milestone. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      name: { type: "string", description: "Swimlane name" },
      description: { type: "string", description: "Swimlane description" },
      dueAt: { type: "string", description: "Sprint due date (YYYY-MM-DD). Omit to leave unchanged; empty string clears it." },
      startAt: { type: "string", description: "Sprint start date (YYYY-MM-DD). Empty string clears it." },
      milestone: { type: "string", description: "Milestone name (case-insensitive). Omit for a loose sprint." },
    },
    required: ["project", "name"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }

      const project = yield* resolveProject(args.project);
      const swimlaneService = yield* SwimlaneService;
      const milestoneId = args.milestone
        ? (yield* resolveMilestone(project.id, args.milestone)).id
        : undefined;
      const swimlane = yield* swimlaneService.create({
        projectId: project.id,
        name: args.name,
        description: args.description,
        dueAt: args.dueAt === "" ? null : args.dueAt,
        startAt: args.startAt === "" ? null : args.startAt,
        milestoneId,
      });

      return {
        id: swimlane.id,
        name: swimlane.name,
        description: swimlane.description,
        position: swimlane.position,
      };
    }),
};
