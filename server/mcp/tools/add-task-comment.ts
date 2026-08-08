import { Effect } from "effect";
import { CommentService } from "../../services/comment.service";
import { markdownToDoc, docToMarkdown } from "../../../shared/markdown";

export const tool = {
  name: "add_task_comment",
  description: "Post a comment on a task (UUID). The comment is Markdown; it is stored as rich text and rendered in the Lexa UI. The agent's API key name is recorded as the author.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      comment: { type: "string", description: "Markdown comment body (non-empty)" },
    },
    required: ["taskId", "comment"],
  },
  handler: (args: any, auth?: { userId: string | null; role: string; keyName: string }) =>
    Effect.gen(function* () {
      const commentService = yield* CommentService;
      const actor = { kind: "agent" as const, label: auth?.keyName ?? "agent", userId: auth?.userId ?? null };
      const result = yield* commentService.create(args.taskId, actor, markdownToDoc(args.comment));
      return { id: result.comment.id, authorLabel: result.comment.authorLabel, body: docToMarkdown(result.comment.body), createdAt: result.comment.createdAt };
    }),
};
