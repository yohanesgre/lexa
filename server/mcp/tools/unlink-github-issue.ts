import { Effect } from "effect";
import { TaskRepo } from "../../repos/task.repo";
import { ActivityService } from "../../services/activity.service";
import { Sqlite, withTx } from "../../db/database";
import * as msg from "../../activity-messages";
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
      const taskRepo = yield* TaskRepo;
      const task = yield* taskRepo.findById(args.taskId).pipe(
        Effect.catchTag("RowNotFound", () =>
          Effect.fail({ code: "TASK_NOT_FOUND", message: `Task not found: ${args.taskId}` })
        )
      );
      const issue = task.githubs.find((g) => g.issueId === args.issueId);
      const db = yield* Sqlite;
      const activityService = yield* ActivityService;
      // Handler-level emission — the unlink lives in the tool, not a service
      // (same documented deviation as the REST route).
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      yield* withTx(db, Effect.gen(function* () {
        yield* taskRepo.unlinkGithubIssue(args.taskId, args.issueId);
        if (issue) {
          yield* activityService.append(args.taskId, actor, "github_unlinked", msg.githubUnlinked(issue.repo, issue.issueNumber));
        }
      }));
      return { unlinked: true };
    }),
};
