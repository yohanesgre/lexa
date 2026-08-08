import { Effect } from "effect";
import { GitHubService } from "../../services/github.service";
import type { Actor } from "../../../shared/types";

export const tool = {
  name: "link_github_issue",
  description: "Create a GitHub issue from a task and link it (repo = 'owner/name'). A task may hold several linked issues, one per repo — a duplicate repo link fails with ALREADY_LINKED.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      repo: { type: "string", description: "GitHub repo owner/name" },
    },
    required: ["taskId", "repo"],
  },
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const githubService = yield* GitHubService;
      // MCP attribution: agent actor; label upgraded to the key name in Task 10.
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      const linked = yield* githubService.createLinkedIssue(actor, args.taskId, args.repo);
      return {
        issueNumber: linked.issueNumber,
        url: `https://github.com/${linked.repo}/issues/${linked.issueNumber}`,
      };
    }),
};
