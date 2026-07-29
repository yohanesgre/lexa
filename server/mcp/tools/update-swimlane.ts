import { Effect } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject, resolveSwimlane } from "../resolve";

export const tool = {
  name: "update_swimlane",
  description: "Update a swimlane's name or description. Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
      name: { type: "string", description: "New name" },
      description: { type: "string", description: "New description" },
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
      const updated = yield* swimlaneService.update(swimlane.id, {
        name: args.name,
        description: args.description,
      });

      return {
        id: updated.id,
        name: updated.name,
        description: updated.description,
        position: updated.position,
      };
    }),
};
