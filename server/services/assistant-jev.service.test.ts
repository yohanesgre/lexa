import { describe, expect, it, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Layer, Context } from "effect";
import { Database } from "bun:sqlite";
import { runMigrations } from "../db/migrate";
import { DbBunLive } from "../db/db";
import { RuntimeEnvLive } from "../runtime-env";
import { SECRETS_MASTER_KEY_INVALID } from "../assistant/secrets";
import { AssistantJevService, JEV_CLEAR_SECRET_CONFLICT_REJECTED, JEV_SECRET_REQUIRES_MASTER_KEY } from "./assistant-jev.service";
import {
  JEV_PREFLIGHT_CONTEXT_CAP,
  JEV_PREFLIGHT_MESSAGE_CAP,
  JEV_PREFLIGHT_STATE_CAP,
  PREFLIGHT_QUESTIONS,
  buildPreflightState,
  jevLog,
  runJevPreflight,
  systemOne,
  type JevPreflightResult,
  type JevQuestions,
  type PreflightStateInput,
} from "../assistant/jev";
import type { RuntimeEnv } from "../env";

const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));
const MASTER_KEY = Buffer.from("s".repeat(32)).toString("base64");

let dir: string;
let db: Database;
let service: AssistantJevService;
let env: RuntimeEnv;

afterEach(() => {
  vi.unstubAllGlobals();
  try { db?.close(); } catch {}
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function setup(masterKey: string | null = MASTER_KEY) {
  dir = mkdtempSync(join(tmpdir(), "lexa-assistant-jev-svc-"));
  const dbPath = join(dir, "test.db");
  runMigrations(dbPath, MIGRATIONS);
  db = new Database(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`INSERT INTO projects (id, name, slug) VALUES ('p1', 'P', 'p1')`);
  env = (masterKey === null ? {} : { LXK_SECRETS_MASTER_KEY: masterKey }) as RuntimeEnv;
  const layer = AssistantJevService.Default.pipe(Layer.provide(Layer.mergeAll(DbBunLive(db), RuntimeEnvLive(env))));
  const ctx = Effect.runSync(Effect.scoped(Layer.build(layer)));
  service = Context.get(ctx, AssistantJevService);
}

// `currentEnv` is read when a service METHOD runs, so the snapshot has to be
// provided to the effect, not only to the built layer.
function run<A, E>(eff: Effect.Effect<A, E>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provide(RuntimeEnvLive(env))) as Effect.Effect<A, E>);
}

const master = MASTER_KEY;

describe("AssistantJevService.readConfig", () => {
  it("returns the seeded singleton, masked, with the capability (secretsEnabled false only without a master key)", async () => {
    setup();
    const view = await run(service.readConfig());
    expect(view).toEqual({
      config: {
        id: "default",
        baseUrl: "https://api.typesafe.ai",
        model: "jev-latest",
        enabled: false,
        hasKey: false,
        keyMask: null,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      },
      secretsEnabled: true,
    });

    setup(null);
    expect((await run(service.readConfig())).secretsEnabled).toBe(false);
    setup(master);
    expect((await run(service.readConfig())).secretsEnabled).toBe(true);
    setup("not-base64");
    // A malformed key still reports the feature as configured, so the save path
    // can name the required shape instead of blaming a missing variable.
    expect((await run(service.readConfig())).secretsEnabled).toBe(true);
  });
});

describe("AssistantJevService.updateConfig", () => {
  it("writes baseUrl/model/enabled and masks a stored key", async () => {
    setup();
    const view = await run(service.updateConfig({ baseUrl: "https://jev.internal", model: "jev-x", enabled: true }));
    expect(view.config).toMatchObject({ baseUrl: "https://jev.internal", model: "jev-x", enabled: true, hasKey: false });

    const keyed = await run(service.updateConfig({ secret: "super-secret-4c8e" }));
    expect(keyed.config.hasKey).toBe(true);
    expect(keyed.config.keyMask).toBe("jev-…4c8e");
    // The plaintext is never in the returned shape.
    expect(JSON.stringify(keyed)).not.toContain("super-secret-4c8e");
    const stored = db.prepare("SELECT ciphertext, iv, key_hint FROM assistant_jev_secrets WHERE config_id = 'default'").get() as { ciphertext: string; iv: string; key_hint: string };
    expect(stored.ciphertext).not.toContain("super-secret-4c8e");
    expect(stored.key_hint).toBe("4c8e");
  });

  it("rejects an invalid baseUrl, a bad model, and a clear/secret conflict", async () => {
    setup();
    for (const baseUrl of ["not a url", "ftp://jev.internal", "https://user:pass@jev.internal"]) {
      const either = await Effect.runPromise(Effect.either(service.updateConfig({ baseUrl }).pipe(Effect.provide(RuntimeEnvLive(env)))));
      expect(either, baseUrl).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevInvalidConfig" }) });
    }
    const longModel = await Effect.runPromise(Effect.either(service.updateConfig({ model: "x".repeat(121) }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(longModel).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevInvalidConfig" }) });

    const conflict = await Effect.runPromise(Effect.either(service.updateConfig({ clearSecret: true, secret: "nope" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(conflict).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevInvalidConfig", reason: JEV_CLEAR_SECRET_CONFLICT_REJECTED }) });
  });

  it("keeps a stored key on an unrelated patch (an empty secret does not clear it) and clears keylessly", async () => {
    setup();
    await run(service.updateConfig({ secret: "keep-me-1234" }));
    const patched = await run(service.updateConfig({ model: "jev-y" }));
    expect(patched.config).toMatchObject({ model: "jev-y", hasKey: true, keyMask: "jev-…1234" });
    const blank = await run(service.updateConfig({ secret: "   " }));
    expect(blank.config.hasKey).toBe(true);

    // No master key at all: the clear is a pure row delete.
    setup(null);
    db.exec(`INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', 'c', 'i', 'active', '9999')`);
    const cleared = await run(service.updateConfig({ clearSecret: true }));
    expect(cleared.config).toMatchObject({ hasKey: false, keyMask: null });
  });

  it("refuses a secret with no master key or a malformed one, before any write", async () => {
    setup(null);
    const noKey = await Effect.runPromise(Effect.either(service.updateConfig({ secret: "abc" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: JEV_SECRET_REQUIRES_MASTER_KEY }) });
    // Nothing was written by the refused call.
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_jev_secrets").get()).toEqual({ n: 0 });

    setup("not-base64");
    const malformed = await Effect.runPromise(Effect.either(service.updateConfig({ secret: "abc" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(malformed).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: SECRETS_MASTER_KEY_INVALID }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_jev_secrets").get()).toEqual({ n: 0 });
  });
});

describe("AssistantJevService.resolveForProject", () => {
  it("resolves the plain runtime config only when every gate passes", async () => {
    setup();
    await run(service.updateConfig({ enabled: true, baseUrl: "https://jev.internal", model: "jev-x" }));
    await run(service.updateConfig({ secret: "key-12345678" }));

    // Project opt-in missing.
    expect(await run(service.resolveForProject("p1"))).toBeNull();

    db.exec(`INSERT INTO assistant_jev_projects (project_id, enabled) VALUES ('p1', 1)`);
    expect(await run(service.resolveForProject("p1"))).toEqual({ apiKey: "key-12345678", baseUrl: "https://jev.internal", model: "jev-x" });

    // Global disabled.
    await run(service.updateConfig({ enabled: false }));
    expect(await run(service.resolveForProject("p1"))).toBeNull();

    // Project disabled.
    await run(service.updateConfig({ enabled: true }));
    db.exec(`UPDATE assistant_jev_projects SET enabled = 0 WHERE project_id = 'p1'`);
    expect(await run(service.resolveForProject("p1"))).toBeNull();
  });

  it("is total: no key, no keyring, or an undecryptable blob all resolve to null", async () => {
    setup();
    await run(service.updateConfig({ enabled: true }));
    db.exec(`INSERT INTO assistant_jev_projects (project_id, enabled) VALUES ('p1', 1)`);
    // No secret row.
    expect(await run(service.resolveForProject("p1"))).toBeNull();

    // A blob encrypted under a different key cannot open.
    db.exec(`INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', 'AAAA', 'AAAAAAAAAAAAAAAA', 'active', '0000')`);
    expect(await run(service.resolveForProject("p1"))).toBeNull();

    // No keyring at all.
    setup(null);
    db.exec(`UPDATE assistant_jev_config SET enabled = 1 WHERE id = 'default'`);
    db.exec(`INSERT INTO assistant_jev_projects (project_id, enabled) VALUES ('p1', 1)`);
    db.exec(`INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', 'AAAA', 'AAAAAAAAAAAAAAAA', 'active', '0000')`);
    expect(await run(service.resolveForProject("p1"))).toBeNull();
  });
});

describe("AssistantJevService.projectAvailable", () => {
  it("is false until global enabled + a stored, openable key all hold, and false without a keyring", async () => {
    setup();
    // Disabled and keyless.
    expect(await run(service.projectAvailable())).toBe(false);

    // Enabled, still keyless.
    await run(service.updateConfig({ enabled: true }));
    expect(await run(service.projectAvailable())).toBe(false);

    // Key stored: available is true even with no project row (the row is
    // deliberately ignored — a member renders the capability from this boolean).
    await run(service.updateConfig({ secret: "avail-key-1234" }));
    expect(await run(service.projectAvailable())).toBe(true);

    // Global disabled wins over a stored key.
    await run(service.updateConfig({ enabled: false }));
    expect(await run(service.projectAvailable())).toBe(false);

    // No keyring, or an undecryptable blob, is false too.
    setup(null);
    db.exec(`UPDATE assistant_jev_config SET enabled = 1 WHERE id = 'default'`);
    db.exec(`INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', 'AAAA', 'AAAAAAAAAAAAAAAA', 'active', '0000')`);
    expect(await run(service.projectAvailable())).toBe(false);

    setup(master);
    db.exec(`UPDATE assistant_jev_config SET enabled = 1 WHERE id = 'default'`);
    db.exec(`INSERT INTO assistant_jev_secrets (config_id, ciphertext, iv, key_id, key_hint) VALUES ('default', 'AAAA', 'AAAAAAAAAAAAAAAA', 'active', '0000')`);
    expect(await run(service.projectAvailable())).toBe(false);
  });
});

describe("AssistantJevService.probe", () => {
  const keyed = async () => {
    setup();
    await run(service.updateConfig({ baseUrl: "https://jev.internal", model: "jev-x", secret: "probe-key-4c8e" }));
  };

  it("lists models on success, maps 401/500 failures, and refuses without a key", async () => {
    await keyed();
    vi.stubGlobal("fetch", (async () =>
      new Response(JSON.stringify({ models: [{ name: "jev-latest", description: "d", release_date: "2026-01-01" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch);
    const result = await run(service.probe());
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(["jev-latest"]);
    expect(typeof result.latencyMs).toBe("number");

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    const auth = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(auth).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevAuthFailed" }) });

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const unreachable = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(unreachable).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevUnreachable" }) });

    setup();
    vi.stubGlobal("fetch", (async () => {
      throw new Error("probe must not reach the network without a key");
    }) as unknown as typeof fetch);
    const noKey = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevInvalidConfig" }) });
  });
});

// ── Carried from server/assistant/jev.test.ts (merged) ─────────────────────

const noulQuestions: JevQuestions = {
  write_intent: {
    type: "noul",
    instructions: "Does this request ask Lexa to change anything?",
    criteria: { true: "the request would mutate something", false: "the request only reads" },
  },
};
const preflightState = { runKind: "chat", latestUserMessage: "rename the sprint" };

function okJson(payload: unknown, body?: string) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(body ?? JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("buildPreflightState + systemOne secrecy and the request-shape guard", () => {
  it("keeps history/attachments/keys out of the state, refuses without a key, keeps key/state out of failures, and accepts PREFLIGHT_QUESTIONS", async () => {
    // buildPreflightState: history, attachments, keys, and secret values never ride along.
    const hostile = {
      runKind: "chat",
      projectId: "p1",
      userMessage: "rename the sprint",
      history: "past turns must never ride along",
      attachments: "attachment bytes",
      apiKey: "tk-secret",
      secret: "hunter2",
    } as unknown as PreflightStateInput;
    const state = buildPreflightState(hostile);
    expect(state).not.toContain("past turns must never ride along");
    expect(state).not.toContain("attachment bytes");
    expect(state).not.toContain("tk-secret");
    expect(state).not.toContain("hunter2");
    expect(Object.keys(JSON.parse(state) as object)).not.toContain("history");

    // Caps: per-field clips (message 2k, context 4k) and the total-state squeeze
    // (8k) — the context gives way first, then the message, then memory items.
    const capped = JSON.parse(
      buildPreflightState({ runKind: "chat", projectId: "p1", userMessage: "m".repeat(3_000), taskWikiContext: "c".repeat(9_000) })
    ) as { userMessage?: string; taskWikiContext?: string };
    expect(capped.userMessage).toHaveLength(JEV_PREFLIGHT_MESSAGE_CAP);
    expect(capped.taskWikiContext).toHaveLength(JEV_PREFLIGHT_CONTEXT_CAP);
    const squeezed = buildPreflightState({
      runKind: "chat",
      projectId: "p1",
      userMessage: "m".repeat(2_000),
      taskWikiContext: "c".repeat(4_000),
      memoryHits: Array.from({ length: 30 }, (_, i) => `mem-${i}-${"x".repeat(400)}`),
    });
    expect(squeezed.length).toBeLessThanOrEqual(JEV_PREFLIGHT_STATE_CAP);
    expect(squeezed).toContain("mem-0-");

    // systemOne: no request when the key is absent or blank.
    let called = 0;
    const countingFetch = (async () => {
      called += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    expect(await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "", fetchImpl: countingFetch })).toEqual({
      ok: false,
      code: "MISSING_KEY",
      message: "Jev API key is not configured",
    });
    expect(await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "   ", fetchImpl: countingFetch })).toMatchObject({ ok: false, code: "MISSING_KEY" });
    expect(called).toBe(0);

    // systemOne: the key and the state never appear in a failure it reports.
    const leakyBody = "Authorization: Bearer tk-super-secret / rename the sprint";
    const leaky = (async () => {
      throw new TypeError(`fetch failed: ${leakyBody}`);
    }) as unknown as typeof fetch;
    const cases = [
      { res: await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "tk-super-secret", fetchImpl: leaky }), code: "NETWORK" },
      { res: await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "tk-super-secret", fetchImpl: (async () => new Response(leakyBody, { status: 401 })) as unknown as typeof fetch }), code: "AUTH" },
      { res: await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "tk-super-secret", fetchImpl: (async () => new Response(leakyBody, { status: 500 })) as unknown as typeof fetch }), code: "HTTP_500" },
      { res: await systemOne({ state: preflightState, questions: noulQuestions, apiKey: "tk-super-secret", fetchImpl: okJson({}, leakyBody).fetchImpl }), code: "INVALID_RESPONSE" },
    ];
    for (const { res, code } of cases) {
      expect(res, code).toMatchObject({ ok: false, code });
      const text = JSON.stringify(res);
      expect(text, code).not.toContain("tk-super-secret");
      expect(text, code).not.toContain("rename the sprint");
    }

    // systemOne: PREFLIGHT_QUESTIONS satisfies the request-shape guard (no 422).
    const { fetchImpl, calls } = okJson({
      model: "jev-latest",
      answers: {
        write_intent: { type: "choice", choice: "write", probabilities: { none: 0.2, read: 0.3, write: 0.5 }, confidence: 0.5 },
        ambiguity: { type: "noul", noul: 0.2 },
        memory_conflict: { type: "noul", noul: 0.9 },
      },
      usage: { input_tokens: 12, output_tokens: 5 },
    });
    const res = await systemOne({ state: preflightState, questions: PREFLIGHT_QUESTIONS, apiKey: "k", fetchImpl });
    expect(res.ok).toBe(true);
    const body = JSON.parse(String(calls[0]!.init.body)) as { questions: JevQuestions };
    expect(Object.keys(body.questions)).toEqual(["write_intent", "ambiguity", "memory_conflict"]);
  });
});

describe("runJevPreflight fail-open + jevLog", () => {
  const config = { apiKey: "tk-secret", baseUrl: "", model: "" };

  it("fails open on every upstream failure, and jevLog records only mode/outcome/code/latency", async () => {
    const cases: Array<{ fetchImpl: typeof fetch; code: string }> = [
      { fetchImpl: (async () => new Response("upstream", { status: 500 })) as unknown as typeof fetch, code: "HTTP_500" },
      { fetchImpl: (async () => new Response("upstream", { status: 401 })) as unknown as typeof fetch, code: "AUTH" },
      { fetchImpl: (async () => new Response("upstream", { status: 403 })) as unknown as typeof fetch, code: "AUTH" },
      { fetchImpl: (async () => new Response("upstream", { status: 429 })) as unknown as typeof fetch, code: "RATE_LIMITED" },
      { fetchImpl: (async () => new Response("upstream", { status: 529 })) as unknown as typeof fetch, code: "RATE_LIMITED" },
      { fetchImpl: (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch, code: "INVALID_RESPONSE" },
      { fetchImpl: (async () => {
        throw new TypeError("connect ECONNREFUSED");
      }) as unknown as typeof fetch, code: "NETWORK" },
    ];
    for (const { fetchImpl, code } of cases) {
      const res = await runJevPreflight({ state: preflightState, config, fetchImpl });
      expect(res, code).toMatchObject({ segment: null, outcome: "failed", code });
    }

    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const failed: JevPreflightResult = {
      segment: "Jev advisory (non-authoritative) — write intent: write",
      outcome: "failed",
      code: "RATE_LIMITED",
      latencyMs: 3_001,
    };
    try {
      jevLog("assess", failed);
      jevLog("preflight", { outcome: "skipped", code: "MISSING_KEY", latencyMs: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(stderr).toHaveLength(2);
    const first = JSON.parse(stderr[0]!) as { level: string; meta: Record<string, unknown> };
    expect(first.level).toBe("WARN");
    expect(first.meta).toEqual({ mode: "assess", outcome: "failed", code: "RATE_LIMITED", latencyMs: 3_001 });
    expect(stderr[0]).not.toContain("write intent");
    expect(stderr[0]).not.toContain("segment");
    const second = JSON.parse(stderr[1]!) as { meta: Record<string, unknown> };
    expect(Object.keys(second.meta)).toEqual(["mode", "outcome", "code", "latencyMs"]);
  });
});

// ── Carried from server/repos/assistant-jev.repo.test.ts (merged) ──────────

describe("AssistantJevService migration + secret storage", () => {
  it("migration 0013 seeds the singleton config, and a re-written secret upserts one row and rotates the IV", async () => {
    setup();
    const row = db.prepare("SELECT id, base_url, model, enabled FROM assistant_jev_config WHERE id = 'default'").get();
    expect(row).toEqual({ id: "default", base_url: "https://api.typesafe.ai", model: "jev-latest", enabled: 0 });
    const secrets = db.prepare("SELECT COUNT(*) AS n FROM assistant_jev_secrets").get() as { n: number };
    expect(secrets.n).toBe(0);

    await run(service.updateConfig({ secret: "rotate-me-1111" }));
    const first = db.prepare("SELECT iv FROM assistant_jev_secrets WHERE config_id = 'default'").get() as { iv: string };
    await run(service.updateConfig({ secret: "rotate-me-2222" }));
    const rows = db.prepare("SELECT iv FROM assistant_jev_secrets WHERE config_id = 'default'").all() as Array<{ iv: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.iv).not.toBe(first.iv);
    const view = await run(service.readConfig());
    expect(view.config).toMatchObject({ hasKey: true, keyMask: "jev-…2222" });
  });
});
