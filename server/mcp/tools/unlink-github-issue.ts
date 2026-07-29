import { Effect } from "effect";

export const tool = {
  name: "unlink_github_issue",
  description: "Unlink a GitHub issue from a task (does not close or delete the issue). STUB — GitHub integration not yet available.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
    },
    required: ["taskId"],
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
