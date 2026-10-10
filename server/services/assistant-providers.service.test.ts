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
import {
  AssistantProvidersService,
  PROVIDER_CLEAR_KEY_CONFLICT_REJECTED,
  PROVIDER_KEY_UNDECRYPTABLE,
  PROVIDER_SECRET_REQUIRES_MASTER_KEY,
  PROVIDER_WORKERS_AI_REQUIRES_KEY,
} from "./assistant-providers.service";
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
  rmSync(dir, { recursive: true, force: true });
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
  it("creates a keyless provider and reports secretsEnabled", async () => {
    setup();
    const view = await run(service.create({ label: "OpenAI", baseUrl: "https://api.test", apiKey: "" }));
    expect(view).toMatchObject({ label: "OpenAI", baseUrl: "https://api.test", hasKey: false, keyMask: null });
    expect(secretRow(view.id)).toBeNull();
    expect(await run(service.secretsEnabled())).toBe(true);
  });

  it("rejects a Workers AI (CF AI base) provider with no key; keeps a keyed one; refuses clearing — ADR-0005 R5", async () => {
    setup();
    const CF = "https://api.cloudflare.com/client/v4/accounts/acc123/ai/v1";
    const noKey = await Effect.runPromise(
      Effect.either(service.create({ label: "CF", baseUrl: CF, apiKey: "" }).pipe(Effect.provide(RuntimeEnvLive(env))))
    );
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_WORKERS_AI_REQUIRES_KEY }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });

    // The bare `.../ai` form (no /v1) must normalize before matching too.
    const bareNoKey = await Effect.runPromise(
      Effect.either(service.create({ label: "CF-bare", baseUrl: "https://api.cloudflare.com/client/v4/accounts/acc123/ai", apiKey: "" }).pipe(Effect.provide(RuntimeEnvLive(env))))
    );
    expect(bareNoKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_WORKERS_AI_REQUIRES_KEY }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });

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

  it("seals a provider key, masks it, and never returns key material", async () => {
    setup();
    const view = await run(service.create({ label: "P", baseUrl: "https://api.test", apiKey: "sk-live-4c8e" }));
    expect(view.hasKey).toBe(true);
    expect(view.keyMask).toBe("sk-…4c8e");
    expect(JSON.stringify(view)).not.toContain("sk-live-4c8e");
    const stored = secretRow(view.id)!;
    expect(stored.ciphertext).not.toContain("sk-live-4c8e");
    expect(stored.key_hint).toBe("4c8e");
    expect(await run(service.resolveApiKey(view.id))).toBe("sk-live-4c8e");
  });

  it("refuses a key with no keyring or a malformed one, before any write", async () => {
    setup(null);
    const noKey = await Effect.runPromise(Effect.either(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(noKey).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: PROVIDER_SECRET_REQUIRES_MASTER_KEY }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });

    setup("not-base64");
    const malformed = await Effect.runPromise(Effect.either(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(malformed).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "SecretKeyUnavailable", reason: SECRETS_MASTER_KEY_INVALID }) });
    expect(db.prepare("SELECT COUNT(*) AS n FROM assistant_providers").get()).toEqual({ n: 0 });
  });

  it("update intent: blank keeps, clearKey removes keylessly, conflict is 422", async () => {
    setup();
    const created = await run(service.create({ label: "P", baseUrl: "https://x", apiKey: "keep-me-1234" }));

    const patched = await run(service.update(created.id, { label: "P2" }));
    expect(patched).toMatchObject({ label: "P2", hasKey: true, keyMask: "sk-…1234" });

    const blank = await run(service.update(created.id, { apiKey: "   " }));
    expect(blank.hasKey).toBe(true);

    const conflict = await Effect.runPromise(Effect.either(service.update(created.id, { clearKey: true, apiKey: "nope" }).pipe(Effect.provide(RuntimeEnvLive(env)))));
    expect(conflict).toMatchObject({ _tag: "Left", left: expect.objectContaining({ _tag: "InvalidArgs", reason: PROVIDER_CLEAR_KEY_CONFLICT_REJECTED }) });

    // No master key at all: the clear is a pure row delete.
    env = {} as RuntimeEnv;
    const cleared = await run(service.update(created.id, { clearKey: true }));
    expect(cleared).toMatchObject({ hasKey: false, keyMask: null });
    expect(secretRow(created.id)).toBeNull();
  });

  it("resolveApiKey: missing row → ''; keyless → ''; undecryptable/no keyring → fixed failure", async () => {
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
  });

  it("rotation: the active+prev keyring still opens a key sealed under the old active key", async () => {
    setup(KEY_A);
    const keyed = await run(service.create({ label: "P", baseUrl: "https://x", apiKey: "sk-rotate-7777" }));
    env = { LXK_SECRETS_MASTER_KEY: KEY_B, LXK_SECRETS_MASTER_KEY_PREV: KEY_A } as RuntimeEnv;
    expect(await run(service.resolveApiKey(keyed.id))).toBe("sk-rotate-7777");
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
