import { Effect } from "effect";
import { GitHubService } from "../../services/github.service";

export const tool = {
  name: "link_github_issue",
  description: "Create a GitHub issue from a task and link it. Supports multiple issues per task (one per repo).",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      repo: { type: "string", description: "GitHub repo owner/name" },
    },
    required: ["taskId", "repo"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const githubService = yield* GitHubService;
      const linked = yield* githubService.createLinkedIssue(args.taskId, args.repo);
      return {
        issueNumber: linked.issueNumber,
        url: `https://github.com/${linked.repo}/issues/${linked.issueNumber}`,
      };
    }),
};
