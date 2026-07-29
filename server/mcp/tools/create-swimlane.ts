import { Effect } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject } from "../resolve";

export const tool = {
  name: "create_swimlane",
  description: "Create a new swimlane in a project. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      name: { type: "string", description: "Swimlane name" },
      description: { type: "string", description: "Swimlane description" },
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
      const swimlane = yield* swimlaneService.create({
        projectId: project.id,
        name: args.name,
        description: args.description,
      });

      return {
        id: swimlane.id,
        name: swimlane.name,
        description: swimlane.description,
        position: swimlane.position,
      };
    }),
};
