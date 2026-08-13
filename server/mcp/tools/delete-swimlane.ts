import { Effect, Either } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject, resolveSwimlane } from "../resolve";

export const tool = {
  name: "delete_swimlane",
  description: "Delete a swimlane. Swimlane must be empty (no tasks). Admin only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      swimlane: { type: "string", description: "Swimlane name (case-insensitive)" },
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
      const result = yield* Effect.either(swimlaneService.delete(swimlane.id));
      if (Either.isLeft(result)) {
        if (result.left._tag === "HasChildren") {
          return {
            isError: true,
            error: { code: "HAS_CHILDREN", message: `Swimlane has ${result.left.count} tasks — move them first` },
          };
        }
        return yield* Effect.fail(result.left);
      }
      return { deleted: true };
    }),
};
