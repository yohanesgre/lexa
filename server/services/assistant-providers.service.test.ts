import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context, Either } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { Sqlite } from "../db/database";
import { DbBunLive } from "../db/db";
import { RuntimeEnvLive } from "../runtime-env";
import { SECRETS_MASTER_KEY_INVALID } from "../assistant/secrets";
import { AssistantHealthRepo } from "../repos/assistant-health.repo";
import { AssistantCatalogService, ASSISTANT_AGENT } from "./assistant-catalog.service";
import { AssistantHealthService } from "./assistant-health.service";
import {
  AssistantProvidersService,
  PROVIDER_KEY_UNDECRYPTABLE,
  PROVIDER_SECRET_REQUIRES_MASTER_KEY,
  PROVIDER_WORKERS_AI_REQUIRES_KEY,
} from "./assistant-providers.service";
import {
  buildAdapter,
  streamChat,
  clientFacingErrorMessage,
  extractRetryAfter,
  isTransientUpstream,
  listModels,
  normalizeBaseUrl,
  type ProviderConfig,
} from "../assistant/provider";
import type { RuntimeEnv } from "../env";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const KEY_A = Buffer.from("a".repeat(32)).toString("base64");
const KEY_B = Buffer.from("b".repeat(32)).toString("base64");

let dir: string;
let db: Database;
let service: AssistantProvidersService;
let env: RuntimeEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(masterKey: string | null = KEY_A) {
  dir = mkdtempSync(join(tmpdir(), "lexa-providers-svc-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  env = (masterKey === null ? {} : { LXK_SECRETS_MASTER_KEY: masterKey }) as RuntimeEnv;
  const layer = AssistantProvidersService.Default.pipe(Layer.provide(Layer.mergeAll(DbBunLive(db), RuntimeEnvLive(env))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  service = Context.get(ctx, AssistantProvidersService);
}

function run<A, E>(eff: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provide(RuntimeEnvLive(env))) as Effect.Effect<A, E>);
}

const secretRow = (id: string) =>
  db.prepare("SELECT ciphertext, iv, key_id, key_hint FROM assistant_provider_secrets WHERE provider_id = ?").get(id) as
    | { ciphertext: string; iv: string; key_id: string; key_hint: string }
    | null;

describe("AssistantProvidersService", () => {
  it("creates a keyless provider (secretsEnabled true), rejects a CF-AI provider with no key, keeps a keyed one, and refuses clearing it", async () => {
    setup();
    const view = await run(service.create({ label: "OpenAI", baseUrl: "https://api.test", apiKey: "" }));
    expect(view).toMatchObject({ label: "OpenAI", baseUrl: "https://api.test", hasKey: false, keyMask: null });
    expect(secretRow(view.id)).toBeNull();
    expect(await run(service.secretsEnabled())).toBe(true);

    const CF = "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1";
    const noKey = await Effect.runPromise(
      Effect.either(service.create({ label: "CF", baseUrl: CF, apiKey: "" }).pipe(Effect.provide(RuntimeEnvLive(env))))
    );
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_WORKERS_AI_REQUIRES_KEY }) });

    // The bare `.../ai` form (no /v1) must normalize before matching too.
    const bareNoKey = await Effect.runPromise(
      Effect.either(service.create({ label: "CF-bare", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai", apiKey: "" }).pipe(Effect.provide(RuntimeEnvLive(env))))
    );
    expect(bareNoKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_WORKERS_AI_REQUIRES_KEY }) });
    // Neither refused create persisted a row.
    expect((db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get() as { n: number }).n).toBe(1);

    const keyed = await run(service.create({ label: "CF", baseUrl: CF, apiKey: "cf-token-9z" }));
    expect(keyed).toMatchObject({ hasKey: true });

    // Clearing the only key on a CF AI provider would leave it broken → refused.
    const cleared = await Effect.runPromise(
      Effect.either(service.update(keyed.id, { clearKey: true }).pipe(Effect.provide(RuntimeEnvLive(env))))
    );
    expect(cleared).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_WORKERS_AI_REQUIRES_KEY }) });
    expect(secretRow(keyed.id)).not.toBeNull();

    // Repointing off the CF base with no key stays legal.
    const repointed = await run(service.update(keyed.id, { baseUrl: "https://api.test" }));
    expect(repointed).toMatchObject({ baseUrl: "https://api.test" });
  });

  it("seals and masks a provider key without returning key material, and refuses a key with no keyring or a malformed one", async () => {
    setup();
    const view = await run(service.create({ label: "P", baseUrl: "https://api.test", apiKey: "sk-live-4c8e" }));
    expect(view.hasKey).toBe(true);
    expect(view.keyMask).toBe("sk-…4c8e");
    expect(JSON.stringify(view)).not.toContain("sk-live-4c8e");
    const stored = secretRow(view.id)!;
    expect(stored.ciphertext).not.toContain("sk-live-4c8e");
    expect(stored.key_hint).toBe("4c8e");
    expect(await run(service.resolveApiKey(view.id))).toBe("sk-live-4c8e");

    setup(null);
    const noKey = await Effect.runPromise(Effect.either(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: PROVIDER_SECRET_REQUIRES_MASTER_KEY }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });

    setup("not-base64");
    const malformed = await Effect.runPromise(Effect.either(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(malformed).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: SECRETS_MASTER_KEY_INVALID }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });
  });

  it("resolveApiKey fails fixed for an undecryptable key, and rotation keeps it open via the prev keyring", async () => {
    setup();
    const keyless = await run(service.create({ label: "A", baseUrl: "https://a", apiKey: "" }));
    expect(await run(service.resolveApiKey(keyless.id))).toBe("");
    expect(await run(service.resolveApiKey("ghost"))).toBe("");

    const keyed = await run(service.create({ label: "B", baseUrl: "https://b", apiKey: "sk-secret-9999" }));
    // No keyring: the stored key is a hard refusal, never a silent empty header.
    env = {} as RuntimeEnv;
    const noKeyring = await Effect.runPromise(Effect.either(service.resolveApiKey(keyed.id).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(noKeyring).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ProviderAuthFailed", message: PROVIDER_KEY_UNDECRYPTABLE }) });

    // Wrong master key: same fixed failure.
    env = { LXK_SECRETS_MASTER_KEY: KEY_B } as RuntimeEnv;
    const undecryptable = await Effect.runPromise(Effect.either(service.resolveApiKey(keyed.id).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(undecryptable).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "ProviderAuthFailed", message: PROVIDER_KEY_UNDECRYPTABLE }) });

    // Rotation: the active+prev keyring still opens a key sealed under the old active key.
    setup(KEY_A);
    const rotated = await run(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk-rotate-7777" }));
    env = { LXK_SECRETS_MASTER_KEY: KEY_B, LXK_SECRETS_MASTER_KEY_PREV: KEY_A } as RuntimeEnv;
    expect(await run(service.resolveApiKey(rotated.id))).toBe("sk-rotate-7777");
  });

  it("list never serializes ciphertext", async () => {
    setup();
    await run(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk-list-4321" }));
    const list = await run(service.list());
    const serialized = JSON.stringify(list);
    expect(serialized).not.toContain("sk-list-4321");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("secret_ciphertext");
    expect(list[0]).toMatchObject({ hasKey: true, keyMask: "sk-…4321" });
  });
});

// Carried from server/assistant/provider.test.ts (merged): the wire/retry
// helpers that drive the provider chain, asserted where the service lives.
describe("provider wire + retry helpers", () => {
  const cfConfig: ProviderConfig = {
    kind: "openai_compatible",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
    apiKey: "cf-token",
    model: "@cf/meta/llama-3.2-1b-instruct",
  };

  const jsonResponse = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("retains required choice only on the initial tool request and omits it for continuation and tool-free entry", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let sideEffects = 0;
    let toolRun = true;
    vi.stubGlobal("fetch", (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push(body);
      if (!Array.isArray(body.tools) || body.tools.length === 0) {
        if (body.tool_choice === "required") {
          return jsonResponse(400, { error: { message: "Tools cannot be empty if tool choice is set to required" } });
        }
        return new Response('data: {"id":"c3","object":"chat.completion.chunk","created":3,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"No tool needed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      if (toolRun && requests.length === 1) {
        if (body.tool_choice !== "required" || !Array.isArray(body.tools) || body.tools.length === 0) {
          return jsonResponse(400, { error: { message: "First request must require an available tool" } });
        }
        return new Response('data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"record_action","arguments":"{\\"value\\":\\"done\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
      }
      if (body.tool_choice === "required") {
        return jsonResponse(400, { error: { message: "Continuation must not force another tool call" } });
      }
      return new Response('data: {"id":"c2","object":"chat.completion.chunk","created":2,"model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Action complete."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n', { headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch);

    const config: ProviderConfig = { kind: "openai_compatible", baseUrl: "https://provider.test/v1", apiKey: "test-key", model: "test-model" };
    let text = "";
    let terminal: string | undefined;
    for await (const chunk of streamChat({
      config,
      systemPrompts: [],
      messages: [{ role: "user", content: "Run action" }],
      tools: [{
        name: "record_action",
        description: "Record one action",
        inputSchema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        execute: ({ value }: { value: string }) => {
          sideEffects += 1;
          return `recorded ${value}`;
        },
      }],
      modelOptions: { tool_choice: "required" },
    })) {
      if (chunk.type === "TEXT_MESSAGE_CONTENT") text += chunk.delta;
      terminal = chunk.type;
    }
    expect(sideEffects).toBe(1);
    expect(requests).toHaveLength(2);
    expect(text).toBe("Action complete.");
    expect(terminal).toBe("RUN_FINISHED");

    requests.length = 0;
    toolRun = false;
    terminal = undefined;
    for await (const chunk of streamChat({
      config,
      systemPrompts: [],
      messages: [{ role: "user", content: "Reply without tools" }],
      tools: [],
      modelOptions: { tool_choice: "required" },
    })) terminal = chunk.type;
    expect(requests).toHaveLength(1);
    expect(terminal).toBe("RUN_FINISHED");
    expect(sideEffects).toBe(1);
  });

  it("clientFacingErrorMessage exposes providerMessage but never raw for provider-tagged errors", () => {
    const msg = clientFacingErrorMessage({
      _tag: "ProviderAuthFailed",
      message: "raw-secret sk-live-123",
      providerMessage: "Incorrect API key",
      raw: "RAW_BODY",
    });
    expect(msg).toBe("Incorrect API key");
    expect(msg).not.toContain("raw-secret");
  });

  it("workers_ai keeps/appends /v1 and the wire routes to the CF AI catalog search with Bearer — ADR-0005 D5", async () => {
    expect(normalizeBaseUrl("https://api.cloudflare.com/client/v4/accounts/acc123/ai", "workers_ai")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
    );
    expect(normalizeBaseUrl("https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1", "workers_ai")).toBe(
      "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1",
    );

    const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
    const res = await listModels(
      { kind: "workers_ai", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1", apiKey: "cf-token", model: "@cf/meta/llama-3.2-1b-instruct" },
      async (input, init) => {
        calls.push({ url: input, init });
        return jsonResponse(200, { result: [{ name: "@cf/meta/llama-3.2-1b-instruct" }], result_info: { per_page: 50, total_count: 1 } });
      },
    );
    expect(calls[0]?.url).toContain("/ai/models/search");
    const headers = new Headers(calls[0]?.init?.headers);
    expect(headers.get("authorization")).toBe("Bearer cf-token");
    expect(res.models).toEqual([{ id: "@cf/meta/llama-3.2-1b-instruct" }]);
  });

  it("falls back to the full catalog when the task filter is rejected, and caps pagination at 10 pages", async () => {
    const urls: string[] = [];
    const res = await listModels(cfConfig, async (input) => {
      urls.push(input);
      if (urls.length === 1) return jsonResponse(400, { success: false });
      return jsonResponse(200, { result: [{ name: "@cf/full" }], result_info: { per_page: 50, total_count: 1 } });
    });
    expect(urls[0]).toContain("task=");
    expect(urls[1]).not.toContain("task=");
    expect(res.models).toEqual([{ id: "@cf/full" }]);

    const paged: string[] = [];
    const capped = await listModels(cfConfig, async (input) => {
      paged.push(input);
      const names = Array.from({ length: 50 }, (_, i) => ({ name: `@cf/model-${paged.length}-${i}` }));
      return jsonResponse(200, { result: names, result_info: { per_page: 50, total_count: 100_000 } });
    });
    expect(paged).toHaveLength(10);
    expect(capped.models).toHaveLength(500);
  });

  it("isTransientUpstream and extractRetryAfter classify retry signals", () => {
    for (const s of [429, 500, 502, 503, 504, 529]) {
      expect(isTransientUpstream(Object.assign(new Error(String(s)), { status: s }))).toBe(true);
      expect(isTransientUpstream({ status: String(s) })).toBe(true);
    }
    expect(isTransientUpstream(Object.assign(new Error("501"), { status: 501 }))).toBe(false);
    for (const m of ["fetch failed", "ECONNREFUSED", "ETIMEDOUT", "getaddrinfo ENOTFOUND", "aborted"]) {
      expect(isTransientUpstream(new Error(m))).toBe(true);
    }
    for (const s of [400, 401, 403, 404, 422]) {
      expect(isTransientUpstream(Object.assign(new Error(String(s)), { status: s }))).toBe(false);
    }

    expect(extractRetryAfter({ headers: { "retry-after": "120" } })).toBe(120_000);
    expect(extractRetryAfter({ rawEvent: { headers: { "retry-after": "5" } } })).toBe(5000);
    expect(extractRetryAfter({ error: { headers: { "retry-after": "1" } } })).toBe(1000);
    expect(extractRetryAfter({ headers: new Headers({ "retry-after": "10" }) })).toBe(10_000);
    expect(extractRetryAfter(new Error("no header"))).toBeNull();
    expect(extractRetryAfter({ status: 429 })).toBeNull();
  });
});

// ── Folded from assistant-meta.service.test.ts ─────────────────────────────

describe("AssistantCatalogService.resetAgentToDefault", () => {
  function metaDb(): { local: string; database: Database } {
    const local = mkdtempSync(join(tmpdir(), "lexa-assistant-meta-svc-"));
    const path = join(local, "test.db");
    runMigrations(path, MIGRATIONS);
    const database = new Database(path);
    // Migrations seed the built-in agent/skills; the reset tests want an empty
    // starting point, so wipe every table first (as the source suite did).
    database.exec("PRAGMA foreign_keys = OFF");
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations' AND name NOT LIKE '%fts%'").all() as Array<{ name: string }>;
    for (const { name } of tables) {
      try { database.exec(`DELETE FROM "${name}"`); } catch {}
    }
    try { database.exec("DELETE FROM sqlite_sequence"); } catch {}
    database.exec("PRAGMA foreign_keys = ON");
    return { local, database };
  }

  function makeCatalogService(database: Database) {
    const layer = AssistantCatalogService.Default.pipe(Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, database), DbBunLive(database))));
    const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
    return Context.get(ctx, AssistantCatalogService);
  }

  function seedAgent(database: Database) {
    for (const id of ASSISTANT_AGENT.skillIds) {
      database.prepare("INSERT INTO lexa_skills (id, name, description, instructions, is_builtin) VALUES (?, ?, '', '', 1)").run(id, id);
    }
    database.prepare("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES (?, 'Assistant Agent', '', 'custom drift', 1)").run(ASSISTANT_AGENT.id);
    database.prepare("INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES (?, 'requirements')").run(ASSISTANT_AGENT.id);
  }

  it("restores instructions and replaces the skill set in one batch, rolling the whole batch back when a replacement insert fails", async () => {
    const { local, database } = metaDb();
    try {
      seedAgent(database);
      const svc = makeCatalogService(database);

      const agent = await Effect.runPromise(svc.resetAgentToDefault(ASSISTANT_AGENT.id));
      expect(agent.instructions).toBe(ASSISTANT_AGENT.instructions);
      expect([...agent.skillIds].sort()).toEqual([...ASSISTANT_AGENT.skillIds].sort());

      // Re-drift, then drop one seeded default: the FK on the junction insert
      // fails, rolling the instructions update and the junction delete back too.
      database.prepare("UPDATE lexa_agents SET instructions = 'custom drift' WHERE id = ?").run(ASSISTANT_AGENT.id);
      database.prepare("DELETE FROM lexa_agent_skills WHERE agent_id = ?").run(ASSISTANT_AGENT.id);
      database.prepare("INSERT INTO lexa_agent_skills (agent_id, skill_id) VALUES (?, 'requirements')").run(ASSISTANT_AGENT.id);
      database.prepare("DELETE FROM lexa_skills WHERE id = 'polish'").run();

      const res = await Effect.runPromise(Effect.either(svc.resetAgentToDefault(ASSISTANT_AGENT.id)));
      expect(Either.isLeft(res)).toBe(true);
      const row = database.prepare("SELECT instructions FROM lexa_agents WHERE id = ?").get(ASSISTANT_AGENT.id) as { instructions: string };
      expect(row.instructions).toBe("custom drift");
      const skills = database.prepare("SELECT skill_id FROM lexa_agent_skills WHERE agent_id = ? ORDER BY skill_id").all(ASSISTANT_AGENT.id) as Array<{ skill_id: string }>;
      expect(skills.map((s) => s.skill_id)).toEqual(["requirements"]);
    } finally {
      database.close();
      rmSync(local, { recursive: true, force: true });
    }
  });

  it("a non-builtin agent → AgentBuiltinDelete", async () => {
    const { local, database } = metaDb();
    try {
      database.prepare("INSERT INTO lexa_agents (id, name, description, instructions, is_builtin) VALUES ('custom', 'Custom', '', '', 0)").run();
      const svc = makeCatalogService(database);
      const res = await Effect.runPromise(Effect.either(svc.resetAgentToDefault("custom")));
      expect(Either.isLeft(res)).toBe(true);
      if (Either.isLeft(res)) expect(res.left._tag).toBe("AgentBuiltinDelete");
    } finally {
      database.close();
      rmSync(local, { recursive: true, force: true });
    }
  });
});

describe("assistant-health.service", () => {
  function tempHealthDb(): { local: string; path: string } {
    const local = mkdtempSync(join(tmpdir(), "lexa-health-svc-test-"));
    const path = join(local, "app.db");
    runMigrations(path, MIGRATIONS);
    return { local, path };
  }

  function runHealth(database: Database, prog: Effect.Effect<void, unknown, any>): Promise<void> {
    const layer = Layer.mergeAll(AssistantHealthRepo.Default, AssistantHealthService.Default).pipe(
      Layer.provide(Layer.mergeAll(Layer.succeed(Sqlite, database), DbBunLive(database)))
    );
    return Effect.runPromise(prog.pipe(Effect.provide(layer)) as Effect.Effect<void, unknown, never>);
  }

  it("defaults closed and opens after 3 consecutive fails (isAllowed false within the window)", async () => {
    const { local, path } = tempHealthDb();
    const database = new Database(path);
    try {
      database.prepare("INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x', '')").run();
      await runHealth(database, Effect.gen(function* () {
        const svc = yield* AssistantHealthService;
        expect(yield* svc.isAllowed("pr1")).toBe(true);
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("closed");
        expect(h.failureCount).toBe(0);

        yield* svc.recordFailure("pr1");
        yield* svc.recordFailure("pr1");
        yield* svc.recordFailure("pr1");
        const open = yield* svc.getHealth("pr1");
        expect(open.circuitState).toBe("open");
        expect(open.consecutiveFailures).toBe(3);
        expect(yield* svc.isAllowed("pr1")).toBe(false);
      }));
    } finally {
      database.close();
      rmSync(local, { recursive: true, force: true });
    }
  });

  it("after 5m open → half-open allows a probe and success closes; a half-open failure re-opens", async () => {
    const { local, path } = tempHealthDb();
    const database = new Database(path);
    try {
      database.prepare("INSERT INTO assistant_providers (id, label, base_url, api_key) VALUES ('pr1','P','https://x', '')").run();
      await runHealth(database, Effect.gen(function* () {
        const svc = yield* AssistantHealthService;
        const repo = yield* AssistantHealthRepo;
        const past = new Date(Date.now() - 6 * 60 * 1000).toISOString();

        yield* repo.upsert({ providerId: "pr1", failureCount: 3, circuitState: "open", openedAt: past, consecutiveFailures: 3 });
        expect(yield* svc.isAllowed("pr1")).toBe(true);
        const h = yield* svc.getHealth("pr1");
        expect(h.circuitState).toBe("half-open");
        yield* svc.recordSuccess("pr1");
        const h2 = yield* svc.getHealth("pr1");
        expect(h2.circuitState).toBe("closed");
        expect(h2.consecutiveFailures).toBe(0);
        expect(yield* svc.isAllowed("pr1")).toBe(true);

        // half-open fail → re-open
        yield* repo.upsert({ providerId: "pr1", failureCount: 3, circuitState: "open", openedAt: past, consecutiveFailures: 3 });
        yield* svc.isAllowed("pr1");
        yield* svc.recordFailure("pr1");
        const h3 = yield* svc.getHealth("pr1");
        expect(h3.circuitState).toBe("open");
        expect(yield* svc.isAllowed("pr1")).toBe(false);
      }));
    } finally {
      database.close();
      rmSync(local, { recursive: true, force: true });
    }
  });
});
