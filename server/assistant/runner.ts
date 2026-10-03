// LexaAssistantRunner — the delegation facet (ADR-0004 §3; H3).
//
// One facet child per delegated run, dispatched by the thread DO through the
// SDK agent-tools surface (`runAgentTool(LexaAssistantRunner, { detached })`).
// The facet is a normal `AIChatAgent`; the SDK supplies the agent-tool adapter
// (`startAgentToolRun`/`cancelAgentToolRun`/…), so this class only implements
// the run turn. It has its own isolate + SQLite and no client addressability.
//
// The dispatch input (`options.body.agentToolInput`, set by the SDK from the
// parent's `runAgentTool` input) carries the goal + signed-identity coordinates.
// The runner rebuilds `AssistantInternalDeps` from its own worker bindings and
// calls the Worker internal routes directly — the same audited execution path
// the parent uses. v1 is read-first: the runner offers read tools always and
// write tools only in `auto` mode (a detached run has no interactive approver
// to answer an `ask` proposal); it never spawns nested runs.
//
// Imported ONLY by `server/workers-entry.ts` (which exports it so the SDK can
// resolve the class through `ctx.exports`) and never by the Bun entry.

import { AIChatAgent } from "@cloudflare/ai-chat";
import type { ToolSet } from "ai";
import type { DurableObjectState, Fetcher } from "@cloudflare/workers-types";
import type { AssistantRunnerInput } from "../../shared/assistant";
import { runAssistantTurn, type AssistantTurnDeps } from "./engine";
import {
  buildMcpToolSet,
  buildReadTools,
  buildWriteTools,
  createAssistantWriteBudget,
  createBudgetedWriteExecutor,
  type AssistantToolTransport,
} from "./tools-ai";
import { MAX_WRITES_PER_TURN } from "./write-tool-names";
import { runnerStopWhen } from "./tool-caps";
import { buildSystemPrompts, CHAT_IDENTITY, IDENTITY, systemPromptText } from "./prompt";
import {
  callReadTool,
  callWriteExecute,
  proposeWrite,
  recordCallLog,
  recordProviderHealthRemote,
  resolveHarnessContext,
  resolveProviderConfigs,
  updateRunRemote,
  type AssistantInternalDeps,
} from "./agent-runtime";
import { assistantTraceParams, tracedAI } from "./tracing";

export interface LexaAssistantRunnerEnv {
  LXK_SECRETS_MASTER_KEY?: string | undefined;
  // Same self service binding the parent uses to reach the Worker internal
  // routes; a facet runs in the same worker and inherits the bindings.
  ASSISTANT_SERVICE?: Fetcher | undefined;
}

function documentTypeOf(threadKey: string): "chat" | "task" | "wiki" | null {
  const separator = threadKey.indexOf(":");
  if (separator <= 0) return null;
  const documentType = threadKey.slice(0, separator);
  return documentType === "chat" || documentType === "task" || documentType === "wiki" ? documentType : null;
}

function runnerErrorResponse(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class LexaAssistantRunner extends AIChatAgent<LexaAssistantRunnerEnv> {
  declare protected ctx: DurableObjectState<Record<string, unknown>>;
  declare protected env: LexaAssistantRunnerEnv;

  private internalDeps(input: AssistantRunnerInput): AssistantInternalDeps | null {
    const masterKey = this.env.LXK_SECRETS_MASTER_KEY;
    const service = this.env.ASSISTANT_SERVICE;
    if (!masterKey || !service) return null;
    return {
      origin: "https://assistant.internal",
      identity: { actorUserId: input.createdBy ?? "", projectId: input.projectId, threadKey: input.threadKey },
      masterKey,
      fetchImpl: (url, init) => service.fetch(url, init as never) as unknown as Promise<Response>,
    };
  }

  override async onChatMessage(
    _onFinish?: unknown,
    options?: { abortSignal?: AbortSignal | undefined; body?: Record<string, unknown> | undefined } | undefined
  ): Promise<Response | undefined> {
    const input = options?.body?.["agentToolInput"] as AssistantRunnerInput | undefined;
    if (
      !input ||
      typeof input.runId !== "string" ||
      typeof input.goal !== "string" ||
      typeof input.projectId !== "string" ||
      typeof input.threadKey !== "string"
    ) {
      return runnerErrorResponse(502, "ASSISTANT_RUN_NOT_FOUND", "Missing run input");
    }
    const deps = this.internalDeps(input);
    if (!deps) return runnerErrorResponse(502, "ASSISTANT_UNAVAILABLE", "Assistant not configured");
    const documentType = documentTypeOf(input.threadKey);
    if (!documentType) return runnerErrorResponse(400, "INVALID_PAYLOAD", "Invalid thread key");
    const sessionId = input.threadKey.slice(input.threadKey.indexOf(":") + 1);

    const turnDeps: AssistantTurnDeps = {
      resolveProviderConfigs: (projectId) => resolveProviderConfigs(deps, projectId),
      recordCallLog: async (entry) => {
        await recordCallLog(deps, entry);
      },
      recordProviderHealth: async ({ providerId, ok }) => {
        await recordProviderHealthRemote(deps, { providerId, ok });
      },
      // Runner terminal transitions land in `assistant_runs` (not the legacy
      // `assistant_tasks` run-status route) and carry the engine's step count so
      // the reloaded run card's progress is accurate (H3 fix 3).
      transitionRun: async (entry) => {
        await updateRunRemote(deps, {
          runId: entry.runId,
          status: entry.status,
          result: entry.result ?? null,
          error: entry.error ?? null,
          ...(entry.stepsUsed !== undefined ? { stepsUsed: entry.stepsUsed } : {}),
        });
      },
    };

    const harness = await resolveHarnessContext(deps, {
      threadKey: input.threadKey,
      runId: input.runId,
      userText: input.goal,
      mode: "runner",
    });

    const batchId = crypto.randomUUID();
    let writeSeq = 0;
    const writeBudget = createAssistantWriteBudget();
    const readAgentId = harness?.agent?.id;
    const transport: AssistantToolTransport = {
      read: (name, args) => callReadTool(deps, name, args, readAgentId),
      propose: (name, args) =>
        proposeWrite(deps, {
          name,
          args,
          batchId,
          seq: writeSeq++,
          projectId: input.projectId,
          documentType,
          documentId: sessionId,
          ownerUserId: input.createdBy ?? "",
          // Run-scoped attribution (ADR-0004 §3; A.8): every proposal this run
          // persists carries the run id so the approval carousel can attribute
          // each chip to the run that proposed it.
          runId: input.runId,
        }),
      execute: createBudgetedWriteExecutor(writeBudget, MAX_WRITES_PER_TURN, (name, args) =>
        callWriteExecute(deps, { name, args, projectId: input.projectId, ownerUserId: input.createdBy ?? "" })
      ),
    };
    // Mode inheritance (D5): reads always; write tools follow the captured mode
    // exactly like a regular turn. In `ask`, proposals persist as pending rows
    // (run-attributed) for later approval; `auto` applies immediately; `deny`
    // refuses locally. The runner deliberately does NOT suspend on a proposal —
    // a detached run has no interactive approver, so it keeps working and
    // completes with the proposals pending.
    const enabledWrite = harness?.writeTools ?? [];
    const availableRead = new Set(harness?.readTools ?? []);
    const tools: ToolSet = {
      ...buildReadTools({ transport, available: availableRead }),
      ...buildMcpToolSet(harness?.mcpTools ?? [], transport),
      ...buildWriteTools({ transport, enabled: enabledWrite, mode: input.mode }),
    };
    const stopWhen = runnerStopWhen();
    const system = systemPromptText(
      buildSystemPrompts({
        identity: documentType === "chat" ? CHAT_IDENTITY : IDENTITY,
        memoryBlock: harness?.memoryBlock ?? null,
        agentMarkdown: harness?.agent?.instructions ?? null,
        skillMarkdowns: harness?.skillMarkdowns ?? [],
        skillCatalog: harness?.skillCatalog ?? null,
        repoContent: harness?.repoContent ?? [],
        docContext: harness?.docContext ?? "",
        mentionContext: harness?.mentionContext ?? "",
        writeTools: enabledWrite,
        advisory: harness?.advisory ?? null,
        threadSummary: harness?.threadSummary ?? null,
      })
    );
    try {
      return await runAssistantTurn(turnDeps, {
        projectId: input.projectId,
        threadKey: input.threadKey,
        sessionId,
        messages: this.messages,
        tools,
        system,
        stopWhen,
        runId: input.runId,
        callLogPurpose: "runner",
        streamTextImpl: tracedAI.streamText,
        trace: assistantTraceParams({
          agentId: this.ctx.id.toString(),
          conversationId: input.threadKey,
          purpose: "runner",
          runId: input.runId,
        }),
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
      });
    } catch (e) {
      console.error("[AssistantRunner] turn failed:", e instanceof Error ? e.message : String(e));
      return runnerErrorResponse(502, "ASSISTANT_GENERATION_FAILED", "Assistant run failed");
    }
  }
}
