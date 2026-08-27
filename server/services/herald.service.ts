import { Effect } from "effect";
import { testConnection as providerTestConnection, type ProviderConfig } from "../herald/provider";
import { HeraldChatService } from "./herald-chat.service";
import { HeraldTaskService } from "./herald-task.service";
import { buildStream, STREAM_STALL_TIMEOUT_MS, STREAM_STALL_MESSAGE, shouldEmitToolFrame, stripToolCallXml, findPendingBatch, applyResumeResults, type StreamRunContext } from "../herald/build-stream";
export { buildStream, STREAM_STALL_TIMEOUT_MS, STREAM_STALL_MESSAGE, shouldEmitToolFrame, stripToolCallXml, findPendingBatch, applyResumeResults, type StreamRunContext } from "../herald/build-stream";
export * from "./herald-helpers";

export class HeraldService extends Effect.Service<HeraldService>()("Lexa/Herald", {
  dependencies: [HeraldChatService.Default, HeraldTaskService.Default],
  effect: Effect.gen(function* () {
    const chat = yield* HeraldChatService;
    const task = yield* HeraldTaskService;
    return {
      enqueue: task.enqueue,
      resetThread: task.resetThread,
      testConnection: (config: ProviderConfig, opts?: { signal?: AbortSignal }) => Effect.tryPromise({ try: () => providerTestConnection(config, opts), catch: (e) => e as import("../api/errors").ProviderAuthFailed | import("../api/errors").ProviderUnreachable | import("../api/errors").HeraldGenerationFailed }),
      abortStream: task.abortStream,
      abortChat: chat.abortChat,
      chatActive: chat.chatActive,
      runStream: task.runStream,
      runChatStream: chat.runChatStream,
      decideApproval: (approvalId: string, userId: string, verdict: "approve" | "reject") => Effect.gen(function* () {
        const c = yield* Effect.either(chat.decideApproval(approvalId, userId, verdict));
        if (c._tag === "Right") return c.right;
        const t = yield* Effect.either(task.decideApproval(approvalId, userId, verdict));
        if (t._tag === "Right") return t.right;
        return yield* Effect.fail(c.left);
      }),
      resumeChatStream: chat.resumeChatStream,
      resumeThreadStream: task.resumeThreadStream,
      listChats: chat.listChats,
      updateChatMeta: chat.updateChatMeta,
    };
  }),
}) {}
