// ADR-0006 — the chat supervisor Durable Object (Workers only).
//
// It owns four things for one chat lane and nothing else:
//   1. a single-writer mutex   — one turn per chat, across isolates;
//   2. a producer that outlives the client request — the run is driven from the
//      DO's `ctx.waitUntil`, so a reload / tab-close / network drop no longer
//      kills the turn;
//   3. an indexed frame buffer — a reconnect replays from `fromIndex` instead of
//      falling back to a D1 transcript read;
//   4. an abort flag the producer honours, so Stop reaches the tool loop.
//
// The engine is unchanged. The DO builds the SAME in-process assistant layer
// over D1 and runs the SAME `AssistantChatService.runChatStream` — TanStack AI,
// one canonical store (`assistant_threads`). No `agents`, no
// `@cloudflare/ai-chat`, no DO SQLite, no WebSocket.
//
// Frames are buffered in memory for the lifetime of the instance: they bridge a
// live reconnect, they are not the durable record (D1 already is). A client that
// reconnects after eviction falls back to the transcript read, as today.

import { DurableObject } from "cloudflare:workers";
import { Effect, Layer } from "effect";
import type { D1Database } from "@cloudflare/workers-types";
import { getEnvFromWorkers, type RuntimeEnv } from "../env";
import { RuntimeEnvLive } from "../runtime-env";
import { Db, type DbDriver } from "../db/db";
import { createD1Driver } from "../db/drivers/d1";
import { d1DatabaseToD1Like } from "../api/workers-ports";
import { assistantServiceLayerWithStorage } from "../api/assistant-api";
import { buildBaseServiceLayerWithStorage } from "../api/http";
import { LoggerLayer } from "../logging/logger";
import { r2StorageConfig, type R2Bucket as NarrowR2Bucket } from "../storage/config";
import { AssistantChatService } from "../services/assistant-chat.service";
import { errorCodeMap, errorMessage, errorToStatus } from "../api/errors";
import type { AssistantChatStreamRequest, StreamFrame } from "../../shared/assistant";

export interface ChatSupervisorEnv extends Record<string, unknown> {
  DB?: D1Database;
}

/** Body of `POST /run` — the Worker route's payload for one chat send. */
export interface ChatSupervisorRunPayload {
  chatId: string;
  userId: string;
  // Frame index to replay from (0 = the whole turn). A reconnect passes the
  // index after the last frame the client rendered.
  fromIndex?: number | undefined;
  request: AssistantChatStreamRequest;
}

interface SupervisedRun {
  chatId: string;
  // The exact user text of this turn. A re-POST carrying the same text is a
  // reconnect of the SAME turn and attaches; different text is a genuine second
  // send and is refused with 409.
  message: string;
  frames: StreamFrame[];
  finished: boolean;
  waiters: Set<() => void>;
}

const HEARTBEAT_MS = 15_000;
const PING = ": ping\n\n";
const SSE_HEADERS = { "content-type": "text/event-stream", "cache-control": "no-cache" } as const;
const JSON_HEADERS = { "content-type": "application/json" } as const;

/** The same layer the Worker request path composes — see
 *  `server/api/assistant-api.ts` `createWorkersApiHandler`. Built per turn, as
 *  the Worker builds it per request. */
function buildAssistantLayer(driver: DbDriver, env: RuntimeEnv) {
  // Workers storage shape (R2 binding) — the same one the Worker entry hands the
  // API handler, so attachments and image loads inside a turn resolve alike.
  const cfg = r2StorageConfig(env, env.BLOB as unknown as NarrowR2Bucket | undefined);
  return Layer.mergeAll(
    buildBaseServiceLayerWithStorage(cfg),
    assistantServiceLayerWithStorage(cfg)
  ).pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Db, driver), RuntimeEnvLive(env), LoggerLayer)));
}

/** `_tag` of a rejected tagged error, or the generic fallback. */
function errorTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error && typeof error._tag === "string") return error._tag;
  return "AssistantGenerationFailed";
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
  return String(error);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export class LexaChatSupervisor extends DurableObject<ChatSupervisorEnv> {
  #run: SupervisedRun | null = null;
  #runtimeEnv: RuntimeEnv | null = null;
  #driver: DbDriver | null = null;

  #runEffect<A, E>(effect: Effect.Effect<A, E, AssistantChatService>): Promise<A> {
    const env = (this.#runtimeEnv ??= getEnvFromWorkers(this.env));
    if (!env.DB) return Promise.reject(new Error("LexaChatSupervisor requires the DB (D1) binding"));
    this.#driver ??= createD1Driver(d1DatabaseToD1Like(env.DB));
    return Effect.runPromise(Effect.provide(effect, buildAssistantLayer(this.#driver, env)));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
    if (url.pathname === "/cancel") return this.#cancel();
    if (url.pathname === "/run") return this.#turn(request);
    return new Response("not found", { status: 404 });
  }

  // ─── turn lifecycle ───────────────────────────────────────────────────
  async #turn(request: Request): Promise<Response> {
    let payload: ChatSupervisorRunPayload;
    try {
      payload = (await request.json()) as ChatSupervisorRunPayload;
    } catch {
      return jsonResponse({ error: { code: "INVALID_ARGS", message: "malformed supervisor payload" } }, 400);
    }

    const active = this.#run;
    if (active && !active.finished) {
      // Same turn → this is a reconnect: replay the buffer and tail it. A
      // different turn → refuse exactly as the in-process mutex does.
      if (active.chatId === payload.chatId && active.message === payload.request.message) {
        return this.#sse(this.#tail(active, payload.fromIndex ?? 0));
      }
      return jsonResponse({ error: { code: "ASSISTANT_TASK_ACTIVE", message: "another run is in progress" } }, 409);
    }

    // Validation/authorization failures reject before any frame exists, so the
    // HTTP status contract stays intact (the same tags the route maps).
    let stream: ReadableStream<StreamFrame>;
    try {
      stream = await this.#runEffect(
        Effect.gen(function* () {
          const service = yield* AssistantChatService;
          return yield* service.runChatStream(payload.chatId, payload.userId, payload.request);
        })
      );
    } catch (error) {
      const tag = errorTag(error);
      return jsonResponse({ error: { code: errorCodeMap[tag] ?? "INTERNAL", message: errorMessage({ _tag: tag }) } }, errorToStatus({ _tag: tag }));
    }

    const run: SupervisedRun = {
      chatId: payload.chatId,
      message: payload.request.message,
      frames: [],
      finished: false,
      waiters: new Set(),
    };
    this.#run = run;
    // Driven off the client request: the run keeps going when the caller goes
    // away, which is the whole point of the supervisor. A NEW run always starts
    // its buffer at 0 — `fromIndex` is meaningful only on an attach to an
    // existing run, so a caller that guesses wrong cannot skip frames.
    this.ctx.waitUntil(this.#pump(run, stream));
    return this.#sse(this.#tail(run, 0));
  }

  async #cancel(): Promise<Response> {
    const run = this.#run;
    if (!run || run.finished) return jsonResponse({ ok: false, reason: "idle" }, 200);
    const chatId = run.chatId;
    try {
      await this.#runEffect(
        Effect.gen(function* () {
          const service = yield* AssistantChatService;
          return service.abortChat(chatId);
        })
      );
    } catch (error) {
      return jsonResponse({ ok: false, reason: errorText(error) }, 200);
    }
    return jsonResponse({ ok: true }, 200);
  }

  // ─── frame buffer ─────────────────────────────────────────────────────
  async #pump(run: SupervisedRun, stream: ReadableStream<StreamFrame>): Promise<void> {
    const reader = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        run.frames.push(value);
        this.#wake(run);
      }
    } catch (error) {
      run.frames.push({ type: "error", code: "ASSISTANT_GENERATION_FAILED", message: errorText(error) });
    } finally {
      run.finished = true;
      this.#wake(run);
    }
  }

  #wake(run: SupervisedRun): void {
    if (run.waiters.size === 0) return;
    const waiters = [...run.waiters];
    run.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  #tail(run: SupervisedRun, fromIndex: number): ReadableStream<StreamFrame> {
    let index = Math.max(0, fromIndex);
    return new ReadableStream<StreamFrame>({
      pull: async (controller) => {
        while (index >= run.frames.length && !run.finished) {
          await new Promise<void>((resolve) => run.waiters.add(resolve));
        }
        const frame = run.frames[index];
        if (frame === undefined) {
          controller.close();
          return;
        }
        index += 1;
        controller.enqueue(frame);
      },
    });
  }

  // Mirrors `sseHttpResponse` (server/api/assistant-api.ts): the frame's `type`
  // is the SSE event name, with a 15 s comment heartbeat to defeat buffering.
  #sse(frames: ReadableStream<StreamFrame>): Response {
    const encoder = new TextEncoder();
    let closed = false;
    let interval: ReturnType<typeof setInterval> | undefined;
    let reader: ReadableStreamDefaultReader<StreamFrame> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const push = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closed = true;
          }
        };
        interval = setInterval(() => push(PING), HEARTBEAT_MS);
        reader = frames.getReader();
        const active = reader;
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await active.read();
              if (done) break;
              push(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
            }
          } catch {
            // upstream died mid-stream — close cleanly, the client sees EOF
          } finally {
            closed = true;
            clearInterval(interval);
            try {
              controller.close();
            } catch {
              // client cancelled mid-stream — controller already closed
            }
          }
        })();
      },
      cancel() {
        closed = true;
        clearInterval(interval);
        void reader?.cancel().catch(() => {});
      },
    });
    return new Response(body, { headers: SSE_HEADERS });
  }
}
