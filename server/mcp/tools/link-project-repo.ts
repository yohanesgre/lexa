import { Effect } from "effect";
import { ProjectService } from "../../services/project.service";

// Admin-only (mirrors the Settings surface). The REST contract is full-replace
// (PUT /projects/:slug/repos); these tools read-modify-write the same list.
// Roles default to keeping the repo's existing flags (or false for a new repo)
// and at least one role must end up true.
export const tool = {
  name: "link_project_repo",
  description:
    "Add or update a GitHub repo link on a project with role flags: source (Forge agent context) and/or workspace (issue linking/sync). Admin only. Pass only the roles to enable; omitted roles keep their current state (new repos default to false). At least one role must be true.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      repo: { type: "string", description: "GitHub repo owner/name" },
      sourceRole: { type: "boolean", description: "Enable the source role (Forge context)" },
      workspaceRole: { type: "boolean", description: "Enable the workspace role (issue linking/sync)" },
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
      const existing = current.find((r) => r.repo === args.repo);
      const merged = {
        repo: args.repo,
        sourceRole: args.sourceRole !== undefined ? args.sourceRole : (existing?.sourceRole ?? false),
        workspaceRole: args.workspaceRole !== undefined ? args.workspaceRole : (existing?.workspaceRole ?? false),
      };
      if (!merged.sourceRole && !merged.workspaceRole) {
        return { isError: true, error: { code: "INVALID_OPTION", message: "At least one role (sourceRole or workspaceRole) must be true" } };
      }
      const next = [...current.filter((r) => r.repo !== args.repo), merged];
      const repos = yield* service.replaceRepos(args.project, next);
      return { repos };
    }),
};
