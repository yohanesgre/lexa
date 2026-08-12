import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";

// Admin-only. Removing a repo (or its workspace role) does NOT unlink existing
// task↔issue links — roles gate new links only.
export const tool = {
  name: "unlink_project_repo",
  description:
    "Remove a GitHub repo link from a project. Admin only. Existing task↔issue links keep syncing — roles gate new links only.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      repo: { type: "string", description: "GitHub repo owner/name to remove" },
    },
    required: ["project", "repo"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      if (!auth || auth.role !== "admin") {
        return { isError: true, error: { code: "FORBIDDEN", message: "Admin access required" } };
      }
      const service = yield* ProjectService;
      const current = yield* service.listRepos(args.project);
      const next = current.filter((r) => r.repo !== args.repo);
      const repos = yield* service.replaceRepos(args.project, next);
      return { repos };
    }),
};
