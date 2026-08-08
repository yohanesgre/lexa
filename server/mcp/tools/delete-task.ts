import { Effect } from "effect";
import { TaskService } from "../../services/task.service";
import type { Actor } from "../../../shared/types";

export const tool = {
  name: "delete_task",
  description: "Delete a task by UUID. Returns confirmation.",
  inputSchema: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Task UUID to delete" },
    },
    required: ["taskId"],
  },
  handler: (args: any, ctx?: { userId: string | null; role: string }) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      const actor: Actor = { kind: "agent", label: "mcp", userId: ctx?.userId ?? null };
      yield* taskService.delete(actor, args.taskId);
      return { deleted: true };
    }),
};
