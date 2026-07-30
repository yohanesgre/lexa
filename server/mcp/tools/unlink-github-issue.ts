import { Effect } from "effect";

export const tool = {
  name: "unlink_github_issue",
  description: "Unlink a specific GitHub issue from a task (does not close or delete the issue). issueId is the GitHub node_id. STUB — GitHub integration not yet available.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      issueId: { type: "string", description: "GitHub issue node_id to unlink" },
    },
    required: ["taskId", "issueId"],
  },
  handler: (_args: any) =>
    Effect.succeed({
      isError: true,
      error: {
        code: "NOT_IMPLEMENTED",
        message: "GitHub integration not yet available",
        details: {},
      },
    }),
};
