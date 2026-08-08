import { Effect } from "effect";
import { ActivityService } from "../../services/activity.service";
import { docToMarkdown } from "../../../shared/markdown";

export const tool = {
  name: "get_task_activity",
  description: "Read the activity timeline for a task (UUID): system events (moves, field changes, links, GitHub sync, Forge runs) and comments, oldest first. Comments are serialized as Markdown. Returns the same page as the REST endpoint; pass nextCursor for older entries.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID" },
      cursor: { type: "string", description: "Opaque pagination cursor (from a previous response)" },
    },
    required: ["taskId"],
  },
  handler: (args: any) =>
    Effect.gen(function* () {
      const activityService = yield* ActivityService;
      const page = yield* activityService.listMerged(args.taskId, args.cursor ?? null, 50);
      return {
        activity: page.items.map((it) =>
          it.kind === "event"
            ? { type: it.type, actor: it.actorKind === "agent" ? `${it.actorLabel} (agent)` : it.actorLabel, at: it.createdAt, message: it.message }
            : { type: "comment", actor: it.authorLabel, at: it.createdAt, message: it.authorLabel, comment: { markdown: docToMarkdown(it.body) } }
        ),
        nextCursor: page.nextCursor,
      };
    }),
};
