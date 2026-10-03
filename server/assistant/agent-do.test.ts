// Miniflare Durable Object smoke + P2 persistence integration (ADR-0003 §B.1,
// §B.3, §B.5). The other assistant tests exercise pure modules; this one proves the
// things that only exist once the class is loaded by workerd:
//   1. `wrangler.jsonc`'s `durable_objects` binding + `new_sqlite_classes`
//      migration actually resolve `LexaAssistantAgent` (the class is exported
//      from the module graph, not merely declared).
//   2. The DO-side HMAC gate runs on a real WebSocket connect and SQLite
//      storage is available (`thread_meta` DDL + insert on the happy path).
//   3. Migrate-on-read: a legacy D1 `assistant_threads` row converts and lands
//      in the DO transcript on first connect.
//   4. Mirror write-back: a persisted step POSTs to the internal mirror route
//      (over a self service binding) and lands in the D1 row.
//   5. `resetThread` clears the framework session rows (no resurrect on a fresh
//      hydrate); `destroyThread` tears down through `_cf_scheduleDestroy` and
//      leaves the session tables usable for a later persist; a seeded
//      summary/count/title survives the COALESCE mirror.
//   6. Load smoke: ten thread-keyed DO instances connect, persist, and read
//      their transcripts back concurrently (no provider turn, so inference
//      concurrency and gateway limits stay live-deploy checks).
//   7. Recovery drill: evicting a live instance rehydrates its durable state
//      and leaves the thread writable (in-flight `runFiber` resume is a
//      live-deploy check, documented in docs/DEPLOYMENT.md).
//
// The wrapper worker stands in for the Worker entry: it serves the internal
// assistant routes against a real miniflare D1 database and forwards the
// WebSocket to the DO. The inline route bodies mirror
// `server/assistant/internal-routes.ts` — that module's SQL/contract is pinned
// by `internal-routes.test.ts`; here it runs behind the DO's real HTTP call.
// The bundle is built with the repo's existing esbuild (transitive via vite /
// wrangler); no new test dependency is declared here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions, kCurrentWorker } from "miniflare";
import { signInternalAuth, type InternalAuthIdentity } from "./internal-auth";

const REPO_ROOT = new URL("../../", import.meta.url);
const MASTER_KEY = "do-smoke-master-key-0123456789";
const THREAD_KEY = "chat:smoke";
const WORKER_NAME = "assistant-do-smoke";
const DB_NAME = "assistant-do-smoke-db";

interface WranglerConfig {
  compatibility_date?: string;
  compatibility_flags?: string[];
  durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
}

// wrangler.jsonc is JSONC: strip block and line comments before parsing. No
// JSON string value in this file contains `//` (verified: the only `*/` is the
// cron expression, inside a string, and it is not `//`).
function loadWranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("wrangler.jsonc", REPO_ROOT), "utf8");
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return JSON.parse(withoutLineComments) as WranglerConfig;
}

const config = loadWranglerConfig();
const binding = config.durable_objects?.bindings?.find((b) => b.name === "ASSISTANT_AGENT");
const class_name = binding?.class_name ?? "";
const sqliteMigration = config.migrations?.find((m) => m.tag === "v1");
const useSQLite = sqliteMigration?.new_sqlite_classes?.includes(class_name) ?? false;

// The wrapper: internal assistant routes are served inline against D1; every
// other request is forwarded to the thread-named DO (the real Worker gate's
// job in production). Only the DO class + its imports are bundled — the Worker
// entry pulls the whole app and is exercised by the workers build.
const ENTRY = `
import { LexaAssistantAgent } from "./server/assistant/agent";
import { LexaAssistantRunner } from "./server/assistant/runner";
export { LexaAssistantAgent, LexaAssistantRunner };

const INTERNAL = "/api/internal/assistant/";

async function handleInternal(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.startsWith(INTERNAL + "legacy/")) {
    const threadKey = decodeURIComponent(url.pathname.slice((INTERNAL + "legacy/").length));
    const sep = threadKey.indexOf(":");
    const row = await env.DB
      .prepare("SELECT messages FROM assistant_threads WHERE document_type = ? AND document_id = ?")
      .bind(threadKey.slice(0, sep), threadKey.slice(sep + 1))
      .first();
    if (!row) return Response.json({ error: { code: "ASSISTANT_THREAD_NOT_FOUND" } }, { status: 404 });
    return Response.json({ messages: JSON.parse(row.messages) });
  }
  if (request.method === "POST" && url.pathname === INTERNAL + "mirror") {
    const body = await request.json();
    const sep = body.threadKey.indexOf(":");
    await env.DB
      .prepare(
        "UPDATE assistant_threads SET messages = ?, summary = COALESCE(?, summary), summarized_count = COALESCE(?, summarized_count), title = COALESCE(title, ?), updated_at = datetime('now') WHERE document_type = ? AND document_id = ?"
      )
      .bind(JSON.stringify(body.messages), body.summary, body.summarizedCount, body.title, body.threadKey.slice(0, sep), body.threadKey.slice(sep + 1))
      .run();
    return Response.json({ ok: true });
  }
  if (request.method === "GET" && url.pathname.startsWith(INTERNAL + "provider-config")) {
    return Response.json({ configs: [{ kind: "openai_compatible", baseUrl: "https://provider.test", apiKey: "sk-test", model: "test-model", providerId: "prov-1" }] });
  }
  if (request.method === "POST" && url.pathname === INTERNAL + "turn-context") {
    const body = await request.json();
    return Response.json({ context: {
      projectId: "proj-1",
      threadKey: body.threadKey,
      documentType: "chat",
      agent: { id: "assistant", name: "Assistant Agent", instructions: "AGENT-MARKDOWN" },
      skillMarkdowns: ["## Skill: Status\\nSKILL-MARKDOWN"],
      skillCatalog: "CATALOG-MARKDOWN",
      memoryBlock: "MEMORY-BLOCK",
      docContext: null,
      repoContent: [],
      mentionContext: null,
      advisory: "ADVISORY-BLOCK",
      threadSummary: { summary: "SUMMARY-BLOCK", summarizedCount: 3 },
      readTools: ["get_task"],
      mcpTools: [],
      writeTools: [],
      primarySupportsImages: false,
      hasSearchKey: false,
      jevConfigured: false,
      delegation: { enabled: false, maxConcurrentRuns: 0 }
    } });
  }
  return Response.json({ error: { code: "ASSISTANT_THREAD_NOT_FOUND" } }, { status: 404 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith(INTERNAL)) return handleInternal(request, env);
    if (url.pathname === "/__test/transcript") {
      const key = url.searchParams.get("threadKey") || ${JSON.stringify(THREAD_KEY)};
      const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(key));
      return Response.json(await stub.getTranscript());
    }
    if (url.pathname === "/__test/persist") {
      const key = url.searchParams.get("threadKey") || ${JSON.stringify(THREAD_KEY)};
      const body = await request.json();
      const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(key));
      await stub.persistMessages(body.messages);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/__test/reset") {
      const key = url.searchParams.get("threadKey") || ${JSON.stringify(THREAD_KEY)};
      const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(key));
      return Response.json(await stub.resetThread());
    }
    if (url.pathname === "/__test/destroy") {
      const key = url.searchParams.get("threadKey") || ${JSON.stringify(THREAD_KEY)};
      const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(key));
      return Response.json(await stub.destroyThread());
    }
    if (url.pathname === "/__test/turn") {
      const key = url.searchParams.get("threadKey") || ${JSON.stringify(THREAD_KEY)};
      const body = await request.json();
      const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(key));
      return Response.json(await stub.saveMessages(body.messages));
    }
    if (url.pathname === "/__test/runner") {
      return Response.json({
        kind: typeof LexaAssistantRunner,
        name: LexaAssistantRunner?.name ?? null,
        hasOnChatMessage: typeof LexaAssistantRunner?.prototype?.onChatMessage === "function",
      });
    }
    const threadKey = request.headers.get("X-Lexa-Thread-Key") || ${JSON.stringify(THREAD_KEY)};
    const stub = env.ASSISTANT_AGENT.get(env.ASSISTANT_AGENT.idFromName(threadKey));
    return stub.fetch(request);
  },
};
`;

interface D1LikeTest {
  exec(q: string): Promise<unknown>;
  prepare(q: string): {
    bind(...p: unknown[]): {
      run(): Promise<unknown>;
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

let mf: Miniflare | undefined;
let d1: D1LikeTest;
// Captured raw provider request body (the AI SDK sends the system prompt as the
// first `system` role message). Set by the worker's `outboundService`.
let capturedProviderRequest: string | null = null;
// H2 summary accounting: non-stream provider calls are the compaction
// `generateText`; `summaryShouldFail` makes the next one 500 (skip-on-failure).
let summaryCalls = 0;
let summaryShouldFail = false;

function providerJson(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "c1",
      object: "chat.completion",
      created: 0,
      model: "test-model",
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

function providerChunk(delta: Record<string, unknown>, finish: string | null, usage?: Record<string, number>): string {
  return JSON.stringify({
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
}

function providerSse(): Response {
  const body =
    [
      providerChunk({ role: "assistant", content: "" }, null),
      providerChunk({ content: "ok" }, null),
      providerChunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]
      .map((part) => `data: ${part}\n\n`)
      .join("") + "data: [DONE]\n\n";
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface Connection {
  status: number;
  closed: { code: number; reason: string } | null;
  readyState: () => number;
}

async function dispatchWebSocket(headers: Record<string, string>): Promise<Connection> {
  const res = await mf!.dispatchFetch("http://assistant-smoke/", {
    headers: { Upgrade: "websocket", ...headers },
  });
  const sock = res.webSocket;
  const connection: Connection = { status: res.status, closed: null, readyState: () => 3 };
  if (!sock) return connection;
  sock.accept();
  connection.readyState = () => sock.readyState;
  sock.addEventListener("close", (event) => {
    connection.closed = { code: event.code, reason: event.reason };
  });
  return connection;
}

function signedHeaders(identity: InternalAuthIdentity): Promise<Record<string, string>> {
  return signInternalAuth(MASTER_KEY, identity).then((internal) => ({
    "X-Lexa-Actor-UserId": identity.actorUserId,
    "X-Lexa-Project-Id": identity.projectId,
    "X-Lexa-Thread-Key": identity.threadKey,
    "X-Lexa-Internal": internal,
  }));
}

async function transcriptOf(documentId: string): Promise<unknown[]> {
  const res = await mf!.dispatchFetch(`http://assistant-smoke/__test/transcript?threadKey=${encodeURIComponent(`chat:${documentId}`)}`);
  const body = (await res.json()) as { messages?: unknown[] };
  return Array.isArray(body.messages) ? body.messages : [];
}

async function d1Messages(documentId: string): Promise<string | null> {
  const row = await d1
    .prepare("SELECT messages FROM assistant_threads WHERE document_id = ?")
    .bind(documentId)
    .first<{ messages: string }>();
  return row ? row.messages : null;
}

async function persistStep(threadKey: string, messages: unknown[]) {
  return mf!.dispatchFetch(`http://assistant-smoke/__test/persist?threadKey=${encodeURIComponent(threadKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
}

async function callThreadControl(op: "reset" | "destroy", threadKey: string) {
  return mf!.dispatchFetch(`http://assistant-smoke/__test/${op}?threadKey=${encodeURIComponent(threadKey)}`);
}

async function durableObjectId(threadKey: string): Promise<string> {
  const namespace = await mf!.getDurableObjectNamespace("ASSISTANT_AGENT", WORKER_NAME);
  return namespace.idFromName(threadKey).toString();
}

// Read the DO's own SQLite session store directly: proves a reset actually
// DELETEs the rows the next hydrate reads, rather than only clearing the
// in-memory cache.
async function sessionMessageCount(threadKey: string): Promise<number> {
  const id = await durableObjectId(threadKey);
  const storage = await mf!.unsafeGetDurableObjectStorage(WORKER_NAME, class_name, { id });
  const rows = await storage.exec<{ n: number }>("SELECT COUNT(*) AS n FROM cf_agents_session_messages");
  return Number(rows[0]?.n ?? 0);
}

// Evict the DO instance so the next RPC boots a fresh instance that re-hydrates
// `this.messages` from SQLite — the path where unrestored rows would resurrect.
async function evictThread(threadKey: string): Promise<void> {
  const id = await durableObjectId(threadKey);
  await mf!.unsafeEvictDurableObject(WORKER_NAME, class_name, { id, webSockets: "close" });
}

// Poll an async probe until it returns a non-null value (the DO start + import
// + mirror are async and can lag the connect/persist call by design).
async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline) throw new Error("timed out waiting for DO persistence");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("LexaAssistantAgent Durable Object smoke", () => {
  beforeAll(async () => {
    const bundled = await build({
      stdin: { contents: ENTRY, resolveDir: REPO_ROOT.pathname, loader: "ts" },
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser", "import", "module"],
      external: ["node:*", "cloudflare:*", "path", "fs", "crypto", "util", "stream", "buffer", "os", "events"],
      write: false,
      logLevel: "silent",
    });
    const script = bundled.outputFiles[0]!.text;
    mf = new Miniflare({
      ...(await convertV4MiniflareOptions({
        workers: [
          {
            name: WORKER_NAME,
            modules: true,
            script,
            compatibilityDate: config.compatibility_date ?? "2026-08-01",
            compatibilityFlags: config.compatibility_flags ?? [],
            durableObjects: { ASSISTANT_AGENT: { className: class_name, useSQLite } },
            d1Databases: { DB: DB_NAME },
            serviceBindings: { ASSISTANT_SERVICE: kCurrentWorker },
            bindings: { LXK_SECRETS_MASTER_KEY: MASTER_KEY },
            // Provider calls go through global fetch; capture the request body
            // and answer with a valid SSE stream so the turn completes offline.
            // Summary (`generateText`) is a non-stream JSON call: count it and
            // answer with a compact completion.
            outboundService: async (request: Request) => {
              const body = await request.text();
              const isStream = /"stream"\s*:\s*true/.test(body);
              if (!isStream) {
                summaryCalls += 1;
                if (summaryShouldFail) {
                  return new Response(JSON.stringify({ error: { message: "summary boom" } }), {
                    status: 500,
                    headers: { "content-type": "application/json" },
                  });
                }
                return providerJson("CONDENSED-SUMMARY");
              }
              capturedProviderRequest = body;
              return providerSse();
            },
          },
        ],
      })),
      // Required for `unsafeGetDurableObjectStorage` / `unsafeEvictDurableObject`
      // (the reset/hydrate assertions inspect the DO's SQLite directly).
      unsafeInspectDurableObjects: true,
    });
    d1 = (await mf.getD1Database("DB", WORKER_NAME)) as unknown as D1LikeTest;
    // D1 `exec` splits on newlines — the DDL must be a single line.
    await d1.exec("CREATE TABLE IF NOT EXISTS assistant_threads (document_type TEXT NOT NULL, document_id TEXT NOT NULL, project_id TEXT NOT NULL, owner_user_id TEXT, title TEXT, pinned INTEGER NOT NULL DEFAULT 0, agent_id TEXT, skill_id TEXT, messages TEXT NOT NULL DEFAULT '[]', summary TEXT, summarized_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), PRIMARY KEY (document_type, document_id))");
  }, 180_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("wrangler.jsonc binds ASSISTANT_AGENT to LexaAssistantAgent with a v1 new_sqlite_classes migration", () => {
    expect(binding).toEqual({ name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" });
    expect(sqliteMigration).toEqual({ tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] });
    expect(useSQLite).toBe(true);
  });

  it("bundles the delegation runner facet class and keeps it out of new_sqlite_classes", async () => {
    const res = await mf!.dispatchFetch("http://assistant-smoke/__test/runner");
    const body = (await res.json()) as { kind: string; name: string; hasOnChatMessage: boolean };
    expect(body.kind).toBe("function");
    expect(body.name).toBe("LexaAssistantRunner");
    expect(body.hasOnChatMessage).toBe(true);
    // A facet class needs no top-level migration entry (ADR-0004 §3/R5).
    expect(sqliteMigration?.new_sqlite_classes ?? []).not.toContain("LexaAssistantRunner");
  });

  it("rejects an unsigned websocket with 1008", async () => {
    // Warm the isolate with a signed connect first so the unsigned negative
    // case does not race the cold DO start; the close frame is then dispatched
    // deterministically and can be hard-asserted. The timing-free unit
    // assertion of the same rule lives in agent-gate.test.ts.
    const warmIdentity: InternalAuthIdentity = {
      actorUserId: "user-warm",
      projectId: "proj-1",
      threadKey: THREAD_KEY,
    };
    const warm = await dispatchWebSocket(await signedHeaders(warmIdentity));
    expect(warm.status).toBe(101);

    const connection = await dispatchWebSocket({});
    expect(connection.status).toBe(101);
    let closed = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && connection.closed === null) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      closed = connection.closed !== null;
    }
    expect(closed).toBe(true);
    expect(connection.closed?.code).toBe(1008);
  }, 60_000);

  it("keeps a correctly signed websocket open and writes thread_meta in SQLite", async () => {
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: THREAD_KEY };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);
    // onConnect ran verifyConnection → ensureThreadMetaTable → pinThreadMeta
    // before super.onConnect; a SQLite failure would have thrown (1011/runtime
    // error) and a bad signature would close 1008.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connection.closed).toBeNull();
    expect(connection.readyState()).toBe(1);
  }, 30_000);

  it("migrates a legacy D1 transcript into the DO on first connect (migrate-on-read)", async () => {
    const documentId = "legacy-import";
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: `chat:${documentId}` };
    const legacy = [
      { role: "user", content: "hello", ts: "2026-01-01T00:00:00.000Z" },
      { role: "assistant", content: "hi", ts: "2026-01-01T00:00:01.000Z", citations: [{ title: "Doc", url: "https://example.test/d" }] },
    ];
    await d1
      .prepare("INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat', ?, 'proj-1', 'user-1', ?)")
      .bind(documentId, JSON.stringify(legacy))
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const messages = await waitFor<unknown[]>(
      () => transcriptOf(documentId).then((m) => (m.length > 0 ? m : null)),
      20_000
    );

    expect(messages).toEqual([
      { id: "legacy-0", role: "user", parts: [{ type: "text", text: "hello" }], metadata: { ts: "2026-01-01T00:00:00.000Z" } },
      {
        id: "legacy-1",
        role: "assistant",
        parts: [{ type: "text", text: "hi" }],
        metadata: { ts: "2026-01-01T00:00:01.000Z", citations: [{ title: "Doc", url: "https://example.test/d" }] },
      },
    ]);
  }, 60_000);

  it("mirrors a persisted step back to the D1 assistant_threads row", async () => {
    const documentId = "mirror-write";
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: `chat:${documentId}` };
    await d1
      .prepare("INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat', ?, 'proj-1', 'user-1', '[]')")
      .bind(documentId)
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const persisted = [{ id: "m1", role: "user", parts: [{ type: "text", text: "mirrored" }] }];
    const res = await mf!.dispatchFetch(
      `http://assistant-smoke/__test/persist?threadKey=${encodeURIComponent(`chat:${documentId}`)}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages: persisted }) }
    );
    expect(res.status).toBe(200);

    const mirrored = await waitFor<string>(
      () => d1Messages(documentId).then((raw) => (raw !== null && raw !== "[]" ? raw : null)),
      20_000
    );
    const parsed = JSON.parse(mirrored) as Array<{ parts?: Array<{ text?: string }> }>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.parts?.[0]?.text).toBe("mirrored");
  }, 60_000);

  it("persists the data-assistant-approval carrier and reads it back from the DO session store", async () => {
    // W7b/WS1 + review item 2: prove the custom data part survives the SDK's
    // persistence sanitizer into SQLite — not just the in-memory array. A
    // fresh DO instance does not rehydrate `this.messages` until a WS connect,
    // so the SQLite session row is the persistence proof.
    const documentId = "carrier-roundtrip";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const diff = { type: "task_create", title: "Write docs", fields: { priority: "high" } };
    const carrierPart = {
      type: "data-assistant-approval",
      data: {
        batchId: "b1",
        approvals: [{ approvalId: "ap1", seq: 0, name: "create_task", detail: "Create “Write docs”", diff }],
      },
    };
    const persisted = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "create a task" }] },
      { id: "a1", role: "assistant", parts: [{ type: "text", text: "I can do that." }, carrierPart] },
    ];
    expect((await persistStep(threadKey, persisted)).status).toBe(200);

    const transcript = await waitFor<unknown[]>(
      () => transcriptOf(documentId).then((m) => (m.length === 2 ? m : null)),
      20_000
    );
    const assistant = transcript[1] as { parts: Array<{ type?: string; data?: unknown }> };
    expect(assistant.parts.find((p) => p.type === "data-assistant-approval")).toEqual(carrierPart);

    // The persisted session row keeps the data part verbatim.
    const id = await durableObjectId(threadKey);
    const storage = await mf!.unsafeGetDurableObjectStorage(WORKER_NAME, class_name, { id });
    const rows = await storage.exec<{ id: string; content: string }>(
      "SELECT id, content FROM cf_agents_session_messages WHERE id = 'a1'"
    );
    const stored = JSON.parse(rows[0]!.content) as { parts: unknown[] };
    expect(stored.parts).toContainEqual(carrierPart);
  }, 60_000);

  it("resetThread clears the DO transcript and it stays cleared across a fresh hydrate", async () => {
    const documentId = "reset-clear";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const persisted = [
      { id: "r1", role: "user", parts: [{ type: "text", text: "one" }] },
      { id: "r2", role: "assistant", parts: [{ type: "text", text: "two" }] },
    ];
    expect((await persistStep(threadKey, persisted)).status).toBe(200);
    await waitFor<number>(() => transcriptOf(documentId).then((m) => (m.length === 2 ? 2 : null)), 20_000);
    expect(await sessionMessageCount(threadKey)).toBe(2);

    const reset = await callThreadControl("reset", threadKey);
    expect(reset.status).toBe(200);
    expect(await reset.json()).toEqual({ ok: true });
    expect(await transcriptOf(documentId)).toEqual([]);
    // `persistMessages([])` would reconcile against the prior transcript and
    // leave the rows behind; the session store must actually be empty.
    expect(await sessionMessageCount(threadKey)).toBe(0);

    // A fresh instance re-hydrates from SQLite. Deleted rows must not come back.
    await evictThread(threadKey);
    expect(await transcriptOf(documentId)).toEqual([]);
  }, 60_000);

  it("destroyThread leaves the framework session tables intact so a later persist does not 500", async () => {
    const documentId = "destroy-reuse";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const before = [{ id: "d1", role: "user", parts: [{ type: "text", text: "before" }] }];
    expect((await persistStep(threadKey, before)).status).toBe(200);
    await waitFor<number>(() => transcriptOf(documentId).then((m) => (m.length === 1 ? 1 : null)), 20_000);

    const destroyed = await callThreadControl("destroy", threadKey);
    expect(destroyed.status).toBe(200);
    expect(await destroyed.json()).toEqual({ ok: true });

    // The old `ctx.storage.deleteAll()` teardown dropped `cf_agents_session_*`,
    // so this write threw `no such table: cf_agents_session_messages`. Routing
    // through `_cf_scheduleDestroy` keeps the SDK's tables usable.
    const after = [{ id: "d2", role: "user", parts: [{ type: "text", text: "after" }] }];
    const res = await persistStep(threadKey, after);
    expect(res.status).toBe(200);
  }, 60_000);

  it("preserves a seeded summary/summarized_count/title across a persisted step", async () => {
    const documentId = "mirror-preserve";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    await d1
      .prepare(
        "INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, title, summary, summarized_count, messages) VALUES ('chat', ?, 'proj-1', 'user-1', 'Seeded Title', 'seeded summary', 9, '[]')"
      )
      .bind(documentId)
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const persisted = [{ id: "m1", role: "user", parts: [{ type: "text", text: "step" }] }];
    expect((await persistStep(threadKey, persisted)).status).toBe(200);
    await waitFor<string>(
      () => d1Messages(documentId).then((raw) => (raw !== null && raw !== "[]" ? raw : null)),
      20_000
    );

    const seeded = await d1
      .prepare("SELECT summary, summarized_count, title FROM assistant_threads WHERE document_id = ?")
      .bind(documentId)
      .first<{ summary: string | null; summarized_count: number; title: string | null }>();
    // The DO sends null until the P3 engine tracks summary state; COALESCE must
    // keep the seeded columns. A literal 0 previously clobbered the count.
    expect(seeded?.summary).toBe("seeded summary");
    expect(seeded?.summarized_count).toBe(9);
    expect(seeded?.title).toBe("Seeded Title");
  }, 60_000);

  it("upgrades a pre-existing thread_meta table by adding permission_mode (guarded ALTER)", async () => {
    // Simulate a DO store created before the feature: `thread_meta` exists
    // WITHOUT `permission_mode`, and a row already lives in it. A
    // `CREATE TABLE IF NOT EXISTS` cannot add a column, so the guarded
    // PRAGMA + ALTER must upgrade it and default the existing row to 'ask'.
    // The DO is booted first (so the storage handle is named), then its
    // `thread_meta` is replaced with the pre-feature schema.
    const documentId = "pre-column";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const id = await durableObjectId(threadKey);
    const storage = await mf!.unsafeGetDurableObjectStorage(WORKER_NAME, class_name, { id });
    await waitFor<boolean>(async () => {
      const rows = await storage.exec(`SELECT thread_key FROM thread_meta WHERE thread_key = '${threadKey}'`);
      return rows.length > 0 ? true : null;
    }, 20_000);

    await storage.exec("DROP TABLE thread_meta");
    await storage.exec(
      "CREATE TABLE thread_meta (thread_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, owner_user_id TEXT, imported_from_d1 INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')))"
    );
    await storage.exec(
      `INSERT INTO thread_meta (thread_key, project_id, owner_user_id) VALUES ('${threadKey}', 'proj-1', 'user-1')`
    );

    // getTranscript re-runs ensureThreadMetaTable on the live instance: the
    // guarded PRAGMA + ALTER must add the column.
    const res = await mf!.dispatchFetch(
      `http://assistant-smoke/__test/transcript?threadKey=${encodeURIComponent(threadKey)}`
    );
    const body = (await res.json()) as { permissionMode?: unknown };
    expect(body.permissionMode).toBe("ask");

    const cols = await storage.exec<{ name: string }>("PRAGMA table_info(thread_meta)");
    expect(cols.some((c) => c.name === "permission_mode")).toBe(true);
    // H2: the same guarded ALTER pass adds the compaction columns to a
    // pre-existing store.
    expect(cols.some((c) => c.name === "summary")).toBe(true);
    expect(cols.some((c) => c.name === "summarized_count")).toBe(true);
    const row = await storage.exec<{ permission_mode: string }>(
      `SELECT permission_mode FROM thread_meta WHERE thread_key = '${threadKey}'`
    );
    expect(row[0]?.permission_mode).toBe("ask");
  }, 60_000);

  it("getTranscript hydrates the sticky permission mode and falls back to ask", async () => {
    const documentId = "perm-hydrate";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const id = await durableObjectId(threadKey);
    const storage = await mf!.unsafeGetDurableObjectStorage(WORKER_NAME, class_name, { id });
    await waitFor<boolean>(async () => {
      const rows = await storage.exec(`SELECT thread_key FROM thread_meta WHERE thread_key = '${threadKey}'`);
      return rows.length > 0 ? true : null;
    }, 20_000);

    const readMode = async (): Promise<unknown> => {
      const res = await mf!.dispatchFetch(
        `http://assistant-smoke/__test/transcript?threadKey=${encodeURIComponent(threadKey)}`
      );
      return ((await res.json()) as { permissionMode?: unknown }).permissionMode;
    };
    // Fresh thread: no column value yet → conservative default.
    expect(await readMode()).toBe("ask");

    await storage.exec(`UPDATE thread_meta SET permission_mode = 'auto' WHERE thread_key = '${threadKey}'`);
    expect(await readMode()).toBe("auto");

    await storage.exec(`UPDATE thread_meta SET permission_mode = 'bogus' WHERE thread_key = '${threadKey}'`);
    expect(await readMode()).toBe("ask");
  }, 60_000);

  it("injects the harness bundle into the model request (agent/skill/memory/advisory/summary)", async () => {
    const documentId = "harness-prompt";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);
    capturedProviderRequest = null;

    const res = await mf!.dispatchFetch(
      `http://assistant-smoke/__test/turn?threadKey=${encodeURIComponent(threadKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [{ id: "h1", role: "user", parts: [{ type: "text", text: "hello there" }] }],
        }),
      }
    );
    expect(res.status).toBe(200);
    await waitFor<string>(() => Promise.resolve(capturedProviderRequest), 20_000);

    const body = capturedProviderRequest ?? "";
    expect(body).toContain("AGENT-MARKDOWN");
    expect(body).toContain("SKILL-MARKDOWN");
    expect(body).toContain("MEMORY-BLOCK");
    expect(body).toContain("ADVISORY-BLOCK");
    expect(body).toContain("SUMMARY-BLOCK");
    expect(body).toContain("[Conversation summary — the 3 earlier turns were condensed]");
  }, 60_000);

  it("compacts past the threshold once, persists real summary/count on the DO and D1", async () => {
    const documentId = "h2-compact";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    await d1
      .prepare(
        "INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat', ?, 'proj-1', 'user-1', '[]')"
      )
      .bind(documentId)
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const messages = Array.from({ length: 41 }, (_, i) => ({
      id: `h2-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `message ${i}` }],
    }));
    summaryCalls = 0;
    expect((await persistStep(threadKey, messages)).status).toBe(200);
    expect(summaryCalls).toBe(1);

    const transcriptRes = await mf!.dispatchFetch(
      `http://assistant-smoke/__test/transcript?threadKey=${encodeURIComponent(threadKey)}`
    );
    const transcript = (await transcriptRes.json()) as {
      messages?: unknown[];
      summary?: string | null;
      summarizedCount?: number | null;
    };
    expect(transcript.summary).toBe("CONDENSED-SUMMARY");
    expect(transcript.summarizedCount).toBe(41 - 8);
    expect(transcript.messages).toHaveLength(41);

    const mirrored = await d1
      .prepare("SELECT summary, summarized_count FROM assistant_threads WHERE document_id = ?")
      .bind(documentId)
      .first<{ summary: string | null; summarized_count: number }>();
    expect(mirrored?.summary).toBe("CONDENSED-SUMMARY");
    expect(mirrored?.summarized_count).toBe(41 - 8);

    // Repeat persist of the SAME transcript: the window is already summarized,
    // so no second provider call ("threshold once").
    expect((await persistStep(threadKey, messages)).status).toBe(200);
    expect(summaryCalls).toBe(1);
  }, 90_000);

  it("compaction survives a wake (summary/count read back from durable thread_meta)", async () => {
    const documentId = "h2-wake";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    await d1
      .prepare(
        "INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, messages) VALUES ('chat', ?, 'proj-1', 'user-1', '[]')"
      )
      .bind(documentId)
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const messages = Array.from({ length: 41 }, (_, i) => ({
      id: `w-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `message ${i}` }],
    }));
    expect((await persistStep(threadKey, messages)).status).toBe(200);

    await evictThread(threadKey);

    const res = await mf!.dispatchFetch(
      `http://assistant-smoke/__test/transcript?threadKey=${encodeURIComponent(threadKey)}`
    );
    const body = (await res.json()) as { summary?: string | null; summarizedCount?: number | null };
    expect(body.summary).toBe("CONDENSED-SUMMARY");
    expect(body.summarizedCount).toBe(41 - 8);
  }, 90_000);

  it("skips compaction on a provider failure and leaves the D1 summary untouched", async () => {
    const documentId = "h2-fail";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey };
    await d1
      .prepare(
        "INSERT INTO assistant_threads (document_type, document_id, project_id, owner_user_id, summary, summarized_count, messages) VALUES ('chat', ?, 'proj-1', 'user-1', 'PRIOR-SUMMARY', 3, '[]')"
      )
      .bind(documentId)
      .run();

    const connection = await dispatchWebSocket(await signedHeaders(identity));
    expect(connection.status).toBe(101);

    const messages = Array.from({ length: 41 }, (_, i) => ({
      id: `f-${i}`,
      role: i % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: `message ${i}` }],
    }));
    summaryCalls = 0;
    summaryShouldFail = true;
    try {
      expect((await persistStep(threadKey, messages)).status).toBe(200);
    } finally {
      summaryShouldFail = false;
    }
    expect(summaryCalls).toBe(1);

    const mirrored = await d1
      .prepare("SELECT summary, summarized_count FROM assistant_threads WHERE document_id = ?")
      .bind(documentId)
      .first<{ summary: string | null; summarized_count: number }>();
    expect(mirrored?.summary).toBe("PRIOR-SUMMARY");
    expect(mirrored?.summarized_count).toBe(3);
  }, 90_000);

  it("load smoke: 10 concurrent threads connect, persist, and read back independently", async () => {
    // WS2 (P6): bounded local load smoke. Ten thread-keyed DO instances are
    // driven concurrently through the real WS gate + persistence + canonical
    // read-back. Does NOT cover inference concurrency (no provider turn, no
    // gateway rate limits, no runFiber recovery) — those are live-deploy checks.
    const COUNT = 10;
    const results = await Promise.all(
      Array.from({ length: COUNT }, async (_, i) => {
        const documentId = `load-${i}`;
        const threadKey = `chat:${documentId}`;
        const identity: InternalAuthIdentity = {
          actorUserId: `user-load-${i}`,
          projectId: "proj-load",
          threadKey,
        };
        const connection = await dispatchWebSocket(await signedHeaders(identity));
        expect(connection.status).toBe(101);

        const persisted = [
          { id: `u${i}`, role: "user", parts: [{ type: "text", text: `hello ${i}` }] },
          { id: `a${i}`, role: "assistant", parts: [{ type: "text", text: `hi ${i}` }] },
        ];
        const res = await persistStep(threadKey, persisted);
        expect(res.status).toBe(200);

        const messages = await waitFor<unknown[]>(
          () => transcriptOf(documentId).then((m) => (m.length === 2 ? m : null)),
          20_000
        );
        expect(messages).toEqual(persisted);
        return messages.length;
      })
    );
    expect(results).toEqual(Array.from({ length: COUNT }, () => 2));
  }, 120_000);

  it("recovery drill: eviction rehydrates the transcript and the thread stays writable", async () => {
    // WS3 (P6): local approximation of a mid-turn isolate eviction/redeploy.
    // No provider turn is started, so this proves state coherence across
    // eviction (persist → evict → reconnect → transcript intact → writable),
    // not runFiber resume of an in-flight turn (live-deploy drill, documented
    // in docs/DEPLOYMENT.md).
    const documentId = "recovery-drill";
    const threadKey = `chat:${documentId}`;
    const identity: InternalAuthIdentity = { actorUserId: "user-rec", projectId: "proj-1", threadKey };

    const first = await dispatchWebSocket(await signedHeaders(identity));
    expect(first.status).toBe(101);
    const persisted = [
      { id: "rec-u1", role: "user", parts: [{ type: "text", text: "before eviction" }] },
      { id: "rec-a1", role: "assistant", parts: [{ type: "text", text: "acknowledged" }] },
    ];
    expect((await persistStep(threadKey, persisted)).status).toBe(200);
    await waitFor<number>(() => transcriptOf(documentId).then((m) => (m.length === 2 ? 2 : null)), 20_000);
    expect(await sessionMessageCount(threadKey)).toBe(2);

    // Evict the instance (closes its sockets). All durable state must survive in
    // DO SQLite; a fresh instance re-hydrates on the next RPC/connect.
    await evictThread(threadKey);

    const second = await dispatchWebSocket(await signedHeaders(identity));
    expect(second.status).toBe(101);
    expect(await transcriptOf(documentId)).toEqual(persisted);
    expect(await sessionMessageCount(threadKey)).toBe(2);

    // The rehydrated instance is still writable: append a message and read back.
    const appended = [
      ...persisted,
      { id: "rec-u2", role: "user", parts: [{ type: "text", text: "after resume" }] },
    ];
    expect((await persistStep(threadKey, appended)).status).toBe(200);
    const after = await waitFor<unknown[]>(
      () => transcriptOf(documentId).then((m) => (m.length === 3 ? m : null)),
      20_000
    );
    expect(after).toEqual(appended);
  }, 60_000);
});
