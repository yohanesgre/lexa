import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import type { Actor } from "../../../shared/types";

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
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      const result = yield* taskService.unlinkGithubIssue(actor, args.taskId, args.issueId);
      return { unlinked: result.unlinked };
    }),
};
