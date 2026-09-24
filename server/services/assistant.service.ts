import { Effect } from "effect";
import { testConnection as providerTestConnection, type ProviderConfig } from "../assistant/provider";
import { AssistantChatService } from "./assistant-chat.service";
import { AssistantTaskService } from "./assistant-task.service";
import { ASSISTANT_STALL_TIMEOUT_MS, ASSISTANT_STALL_MESSAGE } from "../../shared/assistant";
import { buildStream, shouldEmitToolFrame, stripToolCallXml, findPendingBatch, applyResumeResults, type StreamRunContext } from "../assistant/build-stream";
export { buildStream, shouldEmitToolFrame, stripToolCallXml, findPendingBatch, applyResumeResults, type StreamRunContext } from "../assistant/build-stream";
export * from "./assistant-helpers";

export class AssistantService extends Effect.Service<AssistantService>()("Lexa/Assistant", {
  dependencies: [AssistantChatService.Default, AssistantTaskService.Default],
  effect: Effect.gen(function* () {
    const chat = yield* AssistantChatService;
    const task = yield* AssistantTaskService;
    return {
      enqueue: task.enqueue,
      resetThread: task.resetThread,
      testConnection: (config: ProviderConfig, opts?: { signal?: AbortSignal }) => Effect.tryPromise({ try: () => providerTestConnection(config, opts), catch: (e) => e as import("../api/errors").ProviderAuthFailed | import("../api/errors").ProviderUnreachable | import("../api/errors").AssistantGenerationFailed }),
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
