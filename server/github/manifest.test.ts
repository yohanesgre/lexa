import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import {
  MANIFEST_STATE_SETTING_KEY,
  REQUIRED_MANIFEST_PERMISSIONS,
  assertRequiredPermissions,
  buildManifest,
  consumeManifestState,
  createManifestState,
  exchangeManifestCode,
  manifestPostUrl,
} from "./manifest";

// Effect failures reject `runPromise` wrapped in a FiberFailure, so the tag is
// only observable through `Either`.
async function leftTag<A, E extends { _tag: string }>(effect: Effect.Effect<A, E, never>): Promise<string | undefined> {
  const either = await Effect.runPromise(Effect.either(effect));
  return either._tag === "Left" ? either.left._tag : undefined;
}

function freshDb(): Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))"
  );
  return db;
}

describe("buildManifest", () => {
  it("points every URL at the public base and asks for exactly the required scopes", () => {
    const manifest = buildManifest("https://lexa.example.com/");
    expect(manifest).toEqual({
      name: "Lexa",
      url: "https://lexa.example.com",
      hook_attributes: { url: "https://lexa.example.com/api/webhooks/github", active: true },
      redirect_url: "https://lexa.example.com/settings/github/callback",
      public: false,
      default_permissions: { ...REQUIRED_MANIFEST_PERMISSIONS },
      default_events: ["issues"],
    });
  });

  it("manifestPostUrl encodes the one-time state into the GitHub form target", () => {
    expect(manifestPostUrl("a b/c")).toBe("https://github.com/settings/apps/new?state=a%20b%2Fc");
  });
});

describe("manifest state — single-use, expiry, mismatch (one error)", () => {
  let db: Database;
  let driver: ReturnType<typeof createBunSqliteDriver>;

  beforeEach(() => {
    db = freshDb();
    driver = createBunSqliteDriver(db);
  });
  afterEach(() => db.close());

  const create = () => Effect.runPromise(createManifestState(driver));
  const consume = (state: string) => Effect.runPromise(consumeManifestState(driver, state));
  const consumeTag = (state: string) => leftTag(consumeManifestState(driver, state));

  it("accepts the issued state exactly once", async () => {
    const state = await create();
    await expect(consume(state)).resolves.toBeUndefined();
    // Second use fails — the row is consumed on the first attempt.
    expect(await consumeTag(state)).toBe("GithubManifestStateInvalid");
  });

  it("rejects a mismatched state (and still consumes it)", async () => {
    const state = await create();
    expect(await consumeTag(`${state}deadbeef`)).toBe("GithubManifestStateInvalid");
    // The mismatch burned the only chance.
    expect(await consumeTag(state)).toBe("GithubManifestStateInvalid");
  });

  it("rejects an expired state", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(
      MANIFEST_STATE_SETTING_KEY,
      JSON.stringify({ value: "expired-state", expiresMs: Date.now() - 1_000 })
    );
    expect(await consumeTag("expired-state")).toBe("GithubManifestStateInvalid");
  });

  it("rejects an unknown state with the same error", async () => {
    expect(await consumeTag("never-issued")).toBe("GithubManifestStateInvalid");
  });

  it("rejects a corrupt stored payload with the same error", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(MANIFEST_STATE_SETTING_KEY, "{not-json");
    expect(await consumeTag("whatever")).toBe("GithubManifestStateInvalid");
  });

  it("a fresh manifest overwrites the previous state", async () => {
    const first = await create();
    const second = await create();
    await expect(consume(second)).resolves.toBeUndefined();
    expect(await consumeTag(first)).toBe("GithubManifestStateInvalid");
  });
});

describe("assertRequiredPermissions", () => {
  it("accepts a matching report", async () => {
    await expect(
      Effect.runPromise(assertRequiredPermissions({ ...REQUIRED_MANIFEST_PERMISSIONS }))
    ).resolves.toBeUndefined();
  });

  it("treats a missing report as no signal (never a denial)", async () => {
    await expect(Effect.runPromise(assertRequiredPermissions(null))).resolves.toBeUndefined();
    await expect(Effect.runPromise(assertRequiredPermissions(undefined))).resolves.toBeUndefined();
  });

  it("refuses a report missing a required scope or at the wrong level", async () => {
    expect(await leftTag(assertRequiredPermissions({ issues: "read", metadata: "read", contents: "read" }))).toBe(
      "GithubManifestPermissionsDenied"
    );
    expect(await leftTag(assertRequiredPermissions({ issues: "write", metadata: "read" }))).toBe(
      "GithubManifestPermissionsDenied"
    );
  });
});

describe("exchangeManifestCode", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  const json = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

  it("maps GitHub's conversion payload to credentials", async () => {
    fetchMock.mockResolvedValue(
      json({
        id: 4242,
        slug: "lexa-test",
        pem: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
        webhook_secret: "whsec-1",
        permissions: { issues: "write", metadata: "read", contents: "read" },
      })
    );
    const creds = await Effect.runPromise(exchangeManifestCode("the-code"));
    expect(creds).toEqual({
      appId: "4242",
      slug: "lexa-test",
      privateKey: "-----BEGIN RSA PRIVATE KEY-----\nbody\n-----END RSA PRIVATE KEY-----",
      webhookSecret: "whsec-1",
      permissions: { issues: "write", metadata: "read", contents: "read" },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app-manifests/the-code/conversions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("a non-2xx response → GithubManifestExchangeFailed", async () => {
    fetchMock.mockResolvedValue(json({ message: "bad code" }, 404));
    expect(await leftTag(exchangeManifestCode("bad"))).toBe("GithubManifestExchangeFailed");
  });

  it("a payload without credentials → GithubManifestExchangeFailed", async () => {
    fetchMock.mockResolvedValue(json({ id: 1, slug: "x" }));
    expect(await leftTag(exchangeManifestCode("code"))).toBe("GithubManifestExchangeFailed");
  });
});
