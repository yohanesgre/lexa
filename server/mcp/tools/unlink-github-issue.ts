import { Effect } from "effect";
import { TaskRepo } from "../../repos/task.repo";

export const tool = {
  name: "unlink_github_issue",
  description: "Unlink a specific GitHub issue from a task (does not close or delete the issue). issueId is the GitHub node_id.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      issueId: { type: "string", description: "GitHub issue node_id to unlink" },
    },
    required: ["taskId", "issueId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskRepo = yield* TaskRepo;
      yield* taskRepo.unlinkGithubIssue(args.taskId, args.issueId);
      return { unlinked: true };
    }),
};
