import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_DATABASE_PATH,
  DEFAULT_PUBLIC_URL,
  getEnv,
  getEnvFromWorkers,
  isRuntimeEnvStringKey,
  RUNTIME_ENV_STRING_KEYS,
  resolveDatabasePath,
  resolvePublicUrl,
  resolveSecretRef,
  resolveTrustedOrigins,
  resolveTrustedProxyCidrs,
  type RuntimeEnv,
} from "./env";

describe("getEnv", () => {
  it("maps an explicit source without touching process.env", () => {
    const rt = getEnv({
      DATABASE_PATH: "/tmp/x.db",
      PORT: "4000",
      LXK_ENV: "prod",
      LXK_PUBLIC_URL: "https://lexa.example.com",
      LXK_TRUSTED_ORIGINS: "https://a.example.com, https://b.example.com",
      GITHUB_APP_ID: "123",
      LXK_MAX_BODY_MB: "32",
      LXK_RATE_LIMIT_MAX: "1000",
      LXK_RATE_LIMIT_WINDOW_MS: "60000",
      LXK_ASSISTANT_REPO_CAP: "5",
      LOG_LEVEL: "debug",
    });
    expect(rt.DATABASE_PATH).toBe("/tmp/x.db");
    expect(rt.PORT).toBe("4000");
    expect(rt.LXK_ENV).toBe("prod");
    expect(rt.LXK_PUBLIC_URL).toBe("https://lexa.example.com");
    expect(rt.LXK_TRUSTED_ORIGINS).toBe("https://a.example.com, https://b.example.com");
    expect(rt.GITHUB_APP_ID).toBe("123");
    expect(rt.LXK_MAX_BODY_MB).toBe("32");
    expect(rt.LXK_RATE_LIMIT_MAX).toBe("1000");
    expect(rt.LXK_RATE_LIMIT_WINDOW_MS).toBe("60000");
    expect(rt.LXK_ASSISTANT_REPO_CAP).toBe("5");
    expect(rt.LOG_LEVEL).toBe("debug");
  });

  it("falls back to LXK_-prefixed TanStack AI keys", () => {
    const rt = getEnv({ LXK_TANSTACK_AI_DEBUG: "1", LXK_TANSTACK_AI_JSON: "1" } as Record<string, string | undefined>);
    expect(rt.TANSTACK_AI_DEBUG).toBe("1");
    expect(rt.TANSTACK_AI_JSON).toBe("1");
  });
});

describe("legacy env keys are dropped", () => {
  it("never carries removed runtime/daemon keys", () => {
    const rt = getEnv({
      LXK_RUNTIME_DAEMON_TOKEN: "old",
      LXK_RUNTIME_REPO_CAP: "9",
      RUNTIME_STALE_RUN_MIN: "45",
    } as Record<string, string | undefined>);
    expect("LXK_RUNTIME_DAEMON_TOKEN" in rt).toBe(false);
    expect("LXK_RUNTIME_REPO_CAP" in rt).toBe(false);
    expect("RUNTIME_STALE_RUN_MIN" in rt).toBe(false);
  });
});

describe("resolvers", () => {
  it("applies Bun-host defaults when keys are absent", () => {
    expect(resolvePublicUrl({})).toBe(DEFAULT_PUBLIC_URL);
    expect(resolveDatabasePath({})).toBe(DEFAULT_DATABASE_PATH);
    expect(DEFAULT_PUBLIC_URL).toBe("http://localhost:5173");
    expect(DEFAULT_DATABASE_PATH).toBe("/app/data/lexa.db");
  });

  it("prefers explicit values over defaults", () => {
    expect(resolvePublicUrl({ LXK_PUBLIC_URL: "https://x.test" })).toBe("https://x.test");
    expect(resolveDatabasePath({ DATABASE_PATH: "/tmp/y.db" })).toBe("/tmp/y.db");
  });

  it("dev trusted origins add the vite host; prod does not", () => {
    const dev = resolveTrustedOrigins({ LXK_ENV: "dev", LXK_PUBLIC_URL: "https://x.test" });
    expect(dev).toContain("https://x.test");
    expect(dev).toContain("http://localhost:5173");
    const prod = resolveTrustedOrigins({ LXK_ENV: "prod", LXK_PUBLIC_URL: "https://x.test" });
    expect(prod).toContain("https://x.test");
    expect(prod).not.toContain("http://localhost:5173");
  });

  it("appends extra origins and drops blanks", () => {
    const origins = resolveTrustedOrigins({
      LXK_PUBLIC_URL: "https://x.test",
      LXK_TRUSTED_ORIGINS: "https://a.test,, ,https://b.test",
    });
    expect(origins).toEqual(["https://x.test", "https://a.test", "https://b.test"]);
  });

  it("resolveTrustedProxyCidrs splits, trims and dedupes; empty → []", () => {
    expect(resolveTrustedProxyCidrs({})).toEqual([]);
    expect(resolveTrustedProxyCidrs({ LXK_TRUSTED_PROXY_CIDRS: "" })).toEqual([]);
    expect(resolveTrustedProxyCidrs({ LXK_TRUSTED_PROXY_CIDRS: "10.0.0.0/8, 192.168.0.0/16 ,10.0.0.0/8," })).toEqual([
      "10.0.0.0/8",
      "192.168.0.0/16",
    ]);
  });
});

describe("getEnvFromWorkers", () => {
  it("maps the workerd env binding per request", () => {
    const fakeDb = { kind: "d1" };
    const fakeBlob = { kind: "r2" };
    const fakeKv = { kind: "kv" };
    const rt = getEnvFromWorkers({
      LXK_ENV: "prod",
      LXK_PUBLIC_URL: "https://lexa.example.com",
      GITHUB_APP_ID: "123",
      GITHUB_WEBHOOK_SECRET: "whsec",
      LXK_TRUSTED_ORIGINS: "https://a.test",
      LOG_LEVEL: "warn",
      LXK_MAX_BODY_MB: "16",
      LXK_RATE_LIMIT_MAX: "1000",
      LXK_ASSISTANT_REPO_CAP: "5",
      DB: fakeDb,
      BLOB: fakeBlob,
      KV: fakeKv,
      CRON_SECRET: "cron",
    });
    expect(rt.LXK_ENV).toBe("prod");
    expect(rt.LXK_PUBLIC_URL).toBe("https://lexa.example.com");
    expect(rt.GITHUB_APP_ID).toBe("123");
    expect(rt.GITHUB_WEBHOOK_SECRET).toBe("whsec");
    expect(rt.LXK_TRUSTED_ORIGINS).toBe("https://a.test");
    expect(rt.LOG_LEVEL).toBe("warn");
    expect(rt.LXK_MAX_BODY_MB).toBe("16");
    expect(rt.LXK_RATE_LIMIT_MAX).toBe("1000");
    expect(rt.LXK_ASSISTANT_REPO_CAP).toBe("5");
    expect(rt.CRON_SECRET).toBe("cron");
    expect(rt.DB).toBe(fakeDb);
    expect(rt.BLOB).toBe(fakeBlob);
    expect(rt.KV).toBe(fakeKv);
  });

  it("drops Bun-only keys and forces the r2 storage driver", () => {
    const rt = getEnvFromWorkers({ DATABASE_PATH: "/tmp/x.db", PORT: "3000" });
    expect(rt.DATABASE_PATH).toBeUndefined();
    expect(rt.PORT).toBeUndefined();
    expect(rt.LXK_STORAGE_DRIVER).toBe("r2");
    expect(rt.LXK_STORAGE_FS_ROOT).toBeUndefined();
  });

  it("ignores non-string binding values", () => {
    const rt = getEnvFromWorkers({ LXK_MAX_BODY_MB: 16, LOG_LEVEL: null, LXK_API_KEY: 42 });
    expect(rt.LXK_MAX_BODY_MB).toBeUndefined();
    expect(rt.LOG_LEVEL).toBeUndefined();
    // Removed env keys are dropped entirely, never passed through.
    expect("LXK_API_KEY" in rt).toBe(false);
  });
});

// The MCP `env:NAME` allowlist is this list, and this list is the string slots
// of RuntimeEnv itself. If the two ever drift, an `env:` reference is either
// refused for a key that resolves, or accepted for one that cannot.
describe("RUNTIME_ENV_STRING_KEYS", () => {
  // The two builders each copy a subset of the snapshot (the Bun host has no
  // CRON_SECRET binding; Workers forces LXK_STORAGE_DRIVER and drops the
  // Bun-only storage slots). The allowlist is the union: a name is acceptable
  // when EITHER path can copy it, and never narrower than what either copies.
  it("covers exactly the string slots the two builders declare and copy", () => {
    const source = Object.fromEntries(RUNTIME_ENV_STRING_KEYS.map((k) => [k, `v-${k}`]));
    const snapshots: Array<[string, RuntimeEnv]> = [
      ["getEnv", getEnv(source as Record<string, string | undefined>)],
      ["getEnvFromWorkers", getEnvFromWorkers(source)],
    ];
    for (const [name, env] of snapshots) {
      // Nothing either builder copies as a string may be outside the list.
      for (const [key, value] of Object.entries(env)) {
        if (typeof value !== "string") continue;
        expect(RUNTIME_ENV_STRING_KEYS, `${name} copies ${key}`).toContain(key);
      }
    }
    // Every listed name is really copied on at least one path. `key in env` is
    // not enough: a builder may declare a slot as an explicit `undefined`, so the
    // seeded value has to come back out of one of the two snapshots.
    for (const key of RUNTIME_ENV_STRING_KEYS) {
      expect(snapshots.some(([, env]) => env[key] === `v-${key}`), key).toBe(true);
    }
  });

  it("carries a source value through on the path that owns the slot", () => {
    const source = Object.fromEntries(RUNTIME_ENV_STRING_KEYS.map((k) => [k, `v-${k}`]));
    const bun = getEnv(source as Record<string, string | undefined>);
    const workers = getEnvFromWorkers(source);
    expect(bun.GITHUB_WEBHOOK_SECRET).toBe("v-GITHUB_WEBHOOK_SECRET");
    expect(bun.LXK_S3_SECRET_ACCESS_KEY).toBe("v-LXK_S3_SECRET_ACCESS_KEY");
    expect(workers.GITHUB_WEBHOOK_SECRET).toBe("v-GITHUB_WEBHOOK_SECRET");
    expect(workers.CRON_SECRET).toBe("v-CRON_SECRET");
    // Workers path differences are preserved, not forced through the list.
    expect(workers.LXK_STORAGE_DRIVER).toBe("r2");
    expect(bun.CRON_SECRET).toBeUndefined();
  });

  it("names RuntimeEnv string slots only — never a Workers binding", () => {
    // Positive membership is proved by the seeded snapshot round-trip above
    // (asserting `isRuntimeEnvStringKey(k)` for every listed `k` would only
    // restate how the Set is built, so it is not repeated here). What matters
    // is the negative direction: nothing outside the list is a slot.
    // D1/R2/KV bindings are copied as objects, so `env:` can never name them.
    for (const binding of ["DB", "BLOB", "KV"]) {
      expect(isRuntimeEnvStringKey(binding), binding).toBe(false);
    }
    // Arbitrary host/Workers names are outside the snapshot.
    for (const unknown of ["LINEAR_TOKEN", "MCP_REMOTE_TOKEN", "LXK_TANSTACK_AI_DEBUG"]) {
      expect(isRuntimeEnvStringKey(unknown), unknown).toBe(false);
    }
  });

  it("carries the Jev config on both paths, and it is a forwardable env: name", () => {
    // Jev is configured on every runtime, so all three slots must come back
    // from both builders — the generic "copied by at least one path" test
    // cannot catch a slot that only one of them forwards.
    const source = { TYPESAFE_API_KEY: "tk", TYPESAFE_BASE_URL: "https://jev.example.com", TYPESAFE_DEFAULT_MODEL: "jev-x" };
    for (const env of [getEnv(source), getEnvFromWorkers(source)]) {
      expect(env.TYPESAFE_API_KEY).toBe("tk");
      expect(env.TYPESAFE_BASE_URL).toBe("https://jev.example.com");
      expect(env.TYPESAFE_DEFAULT_MODEL).toBe("jev-x");
    }
    // Same class as the other infrastructure keys: the MCP `env:NAME` allowlist
    // is this list, so naming it here forwards it as a Bearer token.
    for (const key of ["TYPESAFE_API_KEY", "TYPESAFE_BASE_URL", "TYPESAFE_DEFAULT_MODEL"]) {
      expect(isRuntimeEnvStringKey(key), key).toBe(true);
    }
  });

  it("resolves both snapshot shapes through resolveSecretRef and fails closed otherwise", () => {
    const bun = getEnv({ GITHUB_WEBHOOK_SECRET: "bun-secret" });
    expect(resolveSecretRef("env:GITHUB_WEBHOOK_SECRET", bun)).toBe("bun-secret");
    const workers = getEnvFromWorkers({ GITHUB_WEBHOOK_SECRET: "workers-secret" });
    expect(resolveSecretRef("env:GITHUB_WEBHOOK_SECRET", workers)).toBe("workers-secret");

    // A Workers binding outside the snapshot is not copied, so it fails closed.
    const outside = getEnvFromWorkers({ MCP_REMOTE_TOKEN: "workers-secret" });
    expect("MCP_REMOTE_TOKEN" in outside).toBe(false);
    expect(resolveSecretRef("env:MCP_REMOTE_TOKEN", outside)).toBeNull();
    // An unset slot is a fail-closed null, not a header with an empty bearer.
    expect(resolveSecretRef("env:CRON_SECRET", workers)).toBeNull();
  });

  // The `env:` branch fails closed on an empty value; `file:` trimmed to "" used
  // to pass that through, producing `Authorization: "Bearer "`. A zero-byte or
  // whitespace-only secret file is no credential either way.
  it("resolves a file reference to null when the file is empty or whitespace-only", () => {
    const dir = mkdtempSync(join(tmpdir(), "lexa-secret-ref-"));
    try {
      const empty = join(dir, "empty");
      writeFileSync(empty, "");
      const blank = join(dir, "blank");
      writeFileSync(blank, "  \n\t\n");
      const real = join(dir, "token");
      writeFileSync(real, "  file-secret\n");

      expect(resolveSecretRef(`file:${empty}`, getEnv({}))).toBeNull();
      expect(resolveSecretRef(`file:${blank}`, getEnv({}))).toBeNull();
      expect(resolveSecretRef(`file:${real}`, getEnv({}))).toBe("file-secret");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("carries both MCP master keys on both paths, and both are forwardable env: names", () => {
    // Managed MCP secrets are configured on every runtime, so both slots must
    // come back from BOTH builders — the generic "copied by at least one path"
    // test cannot catch a slot only one of them forwards. The generic test also
    // pins the membership of each name in the `env:` allowlist.
    const source = { LXK_MCP_MASTER_KEY: "active-key", LXK_MCP_MASTER_KEY_PREV: "prev-key" };
    for (const env of [getEnv(source), getEnvFromWorkers(source)]) {
      expect(env.LXK_MCP_MASTER_KEY).toBe("active-key");
      expect(env.LXK_MCP_MASTER_KEY_PREV).toBe("prev-key");
      for (const key of ["LXK_MCP_MASTER_KEY", "LXK_MCP_MASTER_KEY_PREV"]) {
        expect(isRuntimeEnvStringKey(key), key).toBe(true);
        expect(resolveSecretRef(`env:${key}`, env)).toBe(key === "LXK_MCP_MASTER_KEY" ? "active-key" : "prev-key");
      }
    }
    // Unset on both paths is a clean undefined — the crypto layer reads that
    // as "feature disabled", never as an empty key.
    for (const env of [getEnv({}), getEnvFromWorkers({})]) {
      expect(env.LXK_MCP_MASTER_KEY).toBeUndefined();
      expect(env.LXK_MCP_MASTER_KEY_PREV).toBeUndefined();
    }
  });
});
