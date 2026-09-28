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
  rmSync(dir, { recursive: true, force: true });
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
  it("returns the seeded singleton, masked, with the capability", async () => {
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
  });

  it("reports secretsEnabled false without a master key and true with one", async () => {
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

  it("keeps a stored key on an unrelated patch; an empty secret does not clear it", async () => {
    setup();
    await run(service.updateConfig({ secret: "keep-me-1234" }));
    const patched = await run(service.updateConfig({ model: "jev-y" }));
    expect(patched.config).toMatchObject({ model: "jev-y", hasKey: true, keyMask: "jev-…1234" });
    const blank = await run(service.updateConfig({ secret: "   " }));
    expect(blank.config.hasKey).toBe(true);
  });

  it("clears the key with clearSecret, keylessly", async () => {
    setup(master);
    await run(service.updateConfig({ secret: "clear-me-9999" }));
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
  it("is false until global enabled + a stored, openable key all hold", async () => {
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
  });

  it("is false without a keyring or with an undecryptable blob", async () => {
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

  it("lists models on success and reports latency", async () => {
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
  });

  it("maps a 401 to JevAuthFailed and a 500 to JevUnreachable", async () => {
    await keyed();
    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 401 })) as unknown as typeof fetch);
    const auth = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(auth).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevAuthFailed" }) });

    vi.stubGlobal("fetch", (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch);
    const unreachable = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(unreachable).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevUnreachable" }) });
  });

  it("refuses with JevInvalidConfig when no key is stored", async () => {
    setup();
    vi.stubGlobal("fetch", (async () => {
      throw new Error("probe must not reach the network without a key");
    }) as unknown as typeof fetch);
    const either = await Effect.runPromise(Effect.either(service.probe().pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(either).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "JevInvalidConfig" }) });
  });
});
