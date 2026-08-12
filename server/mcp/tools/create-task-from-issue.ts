import { Effect } from "effect";
import { GitHubService } from "../../services/github.service";
import { TaskService } from "../../services/task.service";

export const tool = {
  name: "create_task_from_github_issue",
  description:
    "Create a Lexa task from a GitHub issue (repo must be a workspace repo of the project). Title comes from the issue, description from its body. The task is auto-linked to the issue; an issue already linked to any task is rejected. Required fields of the first column apply like a normal create.",
  inputSchema: {
    type: "object",
    properties: {
      project: { type: "string", description: "Project slug" },
      repo: { type: "string", description: "GitHub repo owner/name (must be a workspace repo of the project)" },
      issueNumber: { type: "number", description: "GitHub issue number" },
    },
    required: ["project", "repo", "issueNumber"],
  },
  handler: (args: any, ctx?: { userId: string | null }) =>
    Effect.gen(function* () {
      const githubService = yield* GitHubService;
      const taskService = yield* TaskService;
      const actor = { kind: "agent" as const, label: "mcp", userId: ctx?.userId ?? null };
      const { taskId } = yield* githubService.createTaskFromIssue(actor, args.project, args.repo, args.issueNumber);
      const task = yield* taskService.getById(taskId);
      return {
        id: task.id,
        title: task.title,
        project: args.project,
        githubIssue: `${args.repo}#${args.issueNumber}`,
      };
    }),
};
