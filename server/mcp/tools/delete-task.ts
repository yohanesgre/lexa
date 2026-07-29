import { Effect } from "effect";
import { TaskService } from "../../services/task.service";

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
  handler: (args: any) =>
    Effect.gen(function* () {
      const taskService = yield* TaskService;
      yield* taskService.delete(args.taskId);
      return { deleted: true };
    }),
};
