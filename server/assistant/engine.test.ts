import { describe, expect, it } from "vitest";
import { stepCountIs, tool, type UIMessage } from "ai";
import { z } from "zod";
import { AssistantTurnError, runAssistantTurn, turnErrorFor, type AssistantTurnDeps, type RunStatusTransition } from "./engine";
import type { RegistryModelConfig } from "./model-factory";
import type { AssistantCallLogInput } from "../../shared/assistant";

const MESSAGES: UIMessage[] = [{ id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }];

function chunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

function sseResponse(parts: string[]): Response {
  const body = `${parts.map((p) => `data: ${p}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function successFetch(text = "hi"): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async () =>
    sseResponse([
      chunk({ role: "assistant", content: "" }, null),
      chunk({ content: text }, null),
      chunk({}, "stop", { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }),
    ]);
}

function failingFetch(status: number): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async () => new Response(JSON.stringify({ error: { message: "nope" } }), { status, headers: { "content-type": "application/json" } });
}

function config(over: Partial<RegistryModelConfig> = {}): RegistryModelConfig {
  return {
    kind: "openai_compatible",
    baseUrl: "https://provider.test",
    apiKey: "sk-test",
    model: "test-model",
    providerId: "prov-1",
    ...over,
  };
}

interface Recorded {
  logs: AssistantCallLogInput[];
  runs: RunStatusTransition[];
}

function deps(configs: RegistryModelConfig[] | null, recorded: Recorded): AssistantTurnDeps {
  return {
    resolveProviderConfigs: async () => configs,
    recordCallLog: async (input) => {
      recorded.logs.push(input);
    },
    transitionRun: async (input) => {
      recorded.runs.push(input);
    },
  };
}

async function drain(response: Response): Promise<string> {
  return response.text();
}

describe("runAssistantTurn", () => {
  it("streams a turn and records a done call log with usage", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const response = await runAssistantTurn(deps([config({ fetchImpl: successFetch("hello world") })], recorded), {
      projectId: "p1",
      threadKey: "chat:c1",
      sessionId: "c1",
      messages: MESSAGES,
    });
    const body = await drain(response);

    expect(body).toContain("hello world");
    expect(recorded.logs).toHaveLength(1);
    expect(recorded.logs[0]).toMatchObject({
      projectId: "p1",
      providerId: "prov-1",
      model: "test-model",
      kind: "openai_compatible",
      status: "done",
      usageIn: 3,
      usageOut: 2,
    });
  });

  it("reports a completed run status when the turn has a run id", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const response = await runAssistantTurn(deps([config({ fetchImpl: successFetch("done") })], recorded), {
      projectId: "p1",
      threadKey: "task:t1",
      sessionId: "t1",
      runId: "run-1",
      messages: MESSAGES,
    });
    await drain(response);

    expect(recorded.runs).toEqual([{ runId: "run-1", status: "completed", result: "done", error: null, stepsUsed: 1 }]);
  });

  it("walks to a fallback on a retryable (429) primary failure and records both attempts", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const configs = [
      config({ model: "primary", fetchImpl: failingFetch(429) }),
      config({ model: "fallback", fetchImpl: successFetch("from fallback") }),
    ];
    const response = await runAssistantTurn(deps(configs, recorded), {
      projectId: "p1",
      threadKey: "task:t1",
      sessionId: "t1",
      runId: "run-1",
      messages: MESSAGES,
    });
    const body = await drain(response);

    expect(body).toContain("from fallback");
    expect(recorded.logs.map((l) => [l.model, l.status, l.errorCode ?? null])).toEqual([
      ["primary", "error", "PROVIDER_RATE_LIMITED"],
      ["fallback", "done", null],
    ]);
    // The retried primary failure must NOT latch the run `failed`; only the
    // winning fallback attempt owns the terminal transition.
    expect(recorded.runs).toEqual([
      { runId: "run-1", status: "completed", result: "from fallback", error: null, stepsUsed: 1 },
    ]);
  });

  it("fails the run exactly once when every attempt fails with a run id", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const configs = [
      config({ model: "primary", fetchImpl: failingFetch(429) }),
      config({ model: "fallback", fetchImpl: failingFetch(503) }),
    ];
    await expect(
      runAssistantTurn(deps(configs, recorded), {
        projectId: "p1",
        threadKey: "task:t1",
        sessionId: "t1",
        runId: "run-1",
        messages: MESSAGES,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNREACHABLE" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Both attempts logged, but only the exhausted walk's outer catch may land
    // the single `failed` transition (no per-attempt failure transitions).
    expect(recorded.logs.map((l) => [l.model, l.status])).toEqual([
      ["primary", "error"],
      ["fallback", "error"],
    ]);
    expect(recorded.runs).toEqual([
      { runId: "run-1", status: "failed", result: null, error: "Provider unreachable" },
    ]);
  });

  it("maps an exhausted 429 chain to PROVIDER_RATE_LIMITED and fails the run", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const configs = [config({ model: "primary", fetchImpl: failingFetch(429) })];
    await expect(
      runAssistantTurn(deps(configs, recorded), {
        projectId: "p1",
        threadKey: "task:t1",
        sessionId: "t1",
        runId: "run-1",
        messages: MESSAGES,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED", status: 429 });
    expect(recorded.runs).toEqual([{ runId: "run-1", status: "failed", result: null, error: "Provider rate limited" }]);
  });

  it("does not walk past a terminal (401) failure", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const configs = [
      config({ model: "primary", fetchImpl: failingFetch(401) }),
      config({ model: "fallback", fetchImpl: successFetch() }),
    ];
    await expect(
      runAssistantTurn(deps(configs, recorded), {
        projectId: "p1",
        threadKey: "chat:c1",
        sessionId: "c1",
        messages: MESSAGES,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_AUTH_FAILED" });
    expect(recorded.logs.map((l) => l.status)).toEqual(["error"]);
  });

  it("throws PROVIDER_NOT_CONFIGURED when the project has no provider binding", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    await expect(
      runAssistantTurn(deps(null, recorded), {
        projectId: "p1",
        threadKey: "chat:c1",
        sessionId: "c1",
        messages: MESSAGES,
      })
    ).rejects.toBeInstanceOf(AssistantTurnError);
  });
});

describe("turnErrorFor", () => {
  it("maps rate limits, auth, and transient failures to catalog codes", () => {
    expect(turnErrorFor({ status: 429 }).code).toBe("PROVIDER_RATE_LIMITED");
    expect(turnErrorFor({ status: 403 }).code).toBe("PROVIDER_AUTH_FAILED");
    expect(turnErrorFor(new Error("fetch failed")).code).toBe("PROVIDER_UNREACHABLE");
    expect(turnErrorFor(new Error("boom")).code).toBe("ASSISTANT_GENERATION_FAILED");
  });
});

function toolCallFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async () =>
    sseResponse([
      chunk({ role: "assistant", content: "" }, null),
      chunk(
        {
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_task", arguments: '{"ref":"P-1"}' },
            },
          ],
        },
        null
      ),
      chunk({}, "tool_calls", { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 }),
    ]);
}

// A provider whose SSE connection dies after the first token: the peek
// succeeds (so a response is returned), then the stream errors mid-flight.
function midStreamErrorFetch(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const encoder = new TextEncoder();
  return async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls++;
          controller.enqueue(encoder.encode(`data: ${chunk({ role: "assistant", content: "" }, null)}\n\n`));
          return;
        }
        if (pulls === 1) {
          pulls++;
          controller.enqueue(encoder.encode(`data: ${chunk({ content: "partial" }, null)}\n\n`));
          return;
        }
        controller.error(new Error("stream exploded"));
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

describe("runAssistantTurn mid-stream failure", () => {
  it("transport-level stream error (no error part) still transitions the run to failed exactly once", async () => {
    // A provider whose SSE connection dies after the first token: the peek
    // succeeds (so a response is returned), then the body errors on a later
    // read. The AI SDK surfaces this as a stream error (`controller.error`),
    // NOT as an `error` part — `onError` never fires — so the engine's own
    // transport catch must land the terminal transition.
    const recorded: Recorded = { logs: [], runs: [] };
    const response = await runAssistantTurn(
      deps([config({ fetchImpl: midStreamErrorFetch() })], recorded),
      {
        projectId: "p1",
        threadKey: "task:t1",
        sessionId: "t1",
        runId: "run-1",
        messages: MESSAGES,
      }
    );
    await drain(response).catch(() => undefined);
    // The catch runs inside the stream pump; yield once so its async writes land.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded.logs).toHaveLength(1);
    expect(recorded.logs[0]).toMatchObject({ status: "error" });
    expect(recorded.runs).toEqual([
      { runId: "run-1", status: "failed", result: null, error: expect.any(String) },
    ]);

    // A late `onEnd`/duplicate catch must not fire a second terminal transition.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(recorded.runs).toHaveLength(1);
  });

  it("error part before a step (provider rejects the call) still lands exactly one terminal transition", async () => {
    // The other SDK failure surface: the provider returns a non-2xx body, the
    // SDK emits an `error` part and calls `onError`, and the peek throws so the
    // fallback walk/outer catch also reports the failure. The per-turn latch +
    // the Worker route's idempotency gate must collapse these to one row.
    const recorded: Recorded = { logs: [], runs: [] };
    await expect(
      runAssistantTurn(deps([config({ model: "primary", fetchImpl: failingFetch(429) })], recorded), {
        projectId: "p1",
        threadKey: "task:t1",
        sessionId: "t1",
        runId: "run-1",
        messages: MESSAGES,
      })
    ).rejects.toMatchObject({ code: "PROVIDER_RATE_LIMITED" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(recorded.logs).toHaveLength(1);
    expect(recorded.logs[0]).toMatchObject({ status: "error", errorCode: "PROVIDER_RATE_LIMITED" });
    expect(recorded.runs).toEqual([
      { runId: "run-1", status: "failed", result: null, error: "Provider rate limited" },
    ]);
  });
});

// Reasoning-capable provider: a reasoning delta, then content, then the finish
// with usage. The openai-compatible parser emits reasoning-start/delta/end
// around the burst, which the engine observes to time the reasoning span.
function reasoningFetch(text = "answer"): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async () =>
    sseResponse([
      chunk({ role: "assistant", reasoning_content: "thinking" }, null),
      chunk({ content: text }, null),
      chunk({}, "stop", { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 }),
    ]);
}

// The UI message stream frames each chunk as an SSE `data: {json}` line; pull
// the metadata the engine attached to the terminal `finish` part.
function finishMetadata(body: string): unknown {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice("data: ".length).trim();
    if (payload === "[DONE]") continue;
    const parsed = JSON.parse(payload) as { type?: string; messageMetadata?: unknown };
    if (parsed.type === "finish") return parsed.messageMetadata;
  }
  return undefined;
}

describe("runAssistantTurn message metadata", () => {
  it("attaches usage ({in,out}) and a measured reasoningMs to the finish part", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    let clock = 1_000;
    const response = await runAssistantTurn(deps([config({ fetchImpl: reasoningFetch() })], recorded), {
      projectId: "p1",
      threadKey: "chat:c1",
      sessionId: "c1",
      messages: MESSAGES,
      nowMs: () => (clock += 100),
    });
    const body = await drain(response);

    expect(finishMetadata(body)).toEqual({ usage: { in: 7, out: 4 }, reasoningMs: 100 });
  });

  it("omits reasoningMs when the turn emitted no reasoning", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    const response = await runAssistantTurn(deps([config({ fetchImpl: successFetch("plain") })], recorded), {
      projectId: "p1",
      threadKey: "chat:c1",
      sessionId: "c1",
      messages: MESSAGES,
    });
    const body = await drain(response);

    expect(finishMetadata(body)).toEqual({ usage: { in: 3, out: 2 } });
  });

  it("omits usage entirely when the provider reports no token counts", async () => {
    const noUsageFetch = (): ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
      async () =>
        sseResponse([
          chunk({ role: "assistant", content: "" }, null),
          chunk({ content: "plain" }, null),
          chunk({}, "stop"),
        ]);
    const recorded: Recorded = { logs: [], runs: [] };
    const response = await runAssistantTurn(deps([config({ fetchImpl: noUsageFetch() })], recorded), {
      projectId: "p1",
      threadKey: "chat:c1",
      sessionId: "c1",
      messages: MESSAGES,
    });
    const body = await drain(response);

    expect(finishMetadata(body)).toBeUndefined();
  });
});

describe("runAssistantTurn with tools", () => {
  it("executes a tool through the passed ToolSet and streams its output", async () => {
    const recorded: Recorded = { logs: [], runs: [] };
    let seen: { ref: string } | null = null;
    const tools = {
      get_task: tool({
        description: "Read one task",
        inputSchema: z.object({ ref: z.string() }),
        execute: async (args: { ref: string }) => {
          seen = args;
          return { task: { key: args.ref, title: "T" } };
        },
      }),
    };

    const response = await runAssistantTurn(deps([config({ fetchImpl: toolCallFetch() })], recorded), {
      projectId: "p1",
      threadKey: "chat:c1",
      sessionId: "c1",
      messages: MESSAGES,
      tools,
      stopWhen: stepCountIs(1),
    });
    const body = await drain(response);

    expect(seen).toEqual({ ref: "P-1" });
    expect(body).toContain("tool-output-available");
    expect(body).toContain('"key":"P-1"');
    expect(recorded.logs).toHaveLength(1);
  });
});
