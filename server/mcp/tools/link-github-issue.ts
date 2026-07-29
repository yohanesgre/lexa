import { Effect } from "effect";

export const tool = {
  name: "link_github_issue",
  description: "Create a GitHub issue from a task and link it. STUB — GitHub integration not yet available.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      repo: { type: "string", description: "GitHub repo owner/name" },
    },
    required: ["taskId", "repo"],
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
