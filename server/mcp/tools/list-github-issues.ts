import { Effect } from "effect";
import { GitHubService } from "../../services/github.service";

export const tool = {
  name: "list_github_issues",
  description:
    "List recent GitHub issues of a workspace repo of a project (autocomplete backing for issue linking). Text filter runs over the recent 100 issues; an exact #number is looked up directly. Use before link_github_issue / create_task_from_github_issue.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      repo: { type: "string", description: "GitHub repo owner/name (must be a workspace repo of the project)" },
      query: { type: "string", description: "Optional filter: issue #number or title substring" },
    },
    required: ["project", "repo"],
  },
  handler: (args: any, _ctx?: { userId: string | null }) =>
    Effect.gen(function* () {
      const githubService = yield* GitHubService;
      const issues = yield* githubService.listWorkspaceIssues(args.project, args.repo, args.query);
      return { issues };
    }),
};
