import { Effect } from "effect";
import { SwimlaneService } from "../../services/swimlane.service";
import { resolveProject, resolveSwimlane } from "../resolve";
import type { Actor } from "../../../shared/types";

export const tool = {
  name: "restore_swimlane",
  description: "Restore an archived swimlane. Brings the lane back only — its tasks restore individually. Admin only.",
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
      const actor: Actor = { kind: "agent", label: "mcp", userId: auth?.userId ?? null };
      const { lane } = yield* swimlaneService.restore(actor, swimlane.id);

      return {
        message: `Restored swimlane "${lane.name}"`,
      };
    }),
};
