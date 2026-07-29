import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";

export const tool = {
  name: "delete_project",
  description: "Delete a project by slug. Admin only. This removes all tasks, wiki pages, columns, and swimlanes.",
  inputSchema: {
    type: "object",
    properties: {
      slug: { type: "string", description: "Project slug to delete" },
    },
    required: ["slug"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      yield* service.delete(args.slug);
      return { deleted: true };
    }),
};
