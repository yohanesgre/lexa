import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createPrivateKey } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { GithubApiError } from "../api/errors";
import { createAppJwt, verifyWebhookSignature } from "./crypto";
import { GitHubClient, syncGitHubConfigFromDbAsync, resetGithubCaches } from "./client";
import { selectRepoFiles } from "./repo-content";

async function makeTestPem(pkcs1 = false): Promise<string> {
  const keyPair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  );
  const raw = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const b64 = Buffer.from(raw).toString("base64");
  const lines = b64.match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----`;
  if (!pkcs1) return pem;
  // Convert to the PKCS#1 form GitHub actually ships ("BEGIN RSA PRIVATE KEY").
  return createPrivateKey(pem)
    .export({ type: "pkcs1", format: "pem" })
    .toString();
}

function decodeJwtParts(jwt: string): { header: any; payload: any } {
  const [h, p] = jwt.split(".") as [string, string, ...string[]];
  const decode = (seg: string) => JSON.parse(Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"));
  return { header: decode(h!), payload: decode(p!) };
}

describe("createAppJwt", () => {
  it("emits a JWT with the app id claim and valid window", async () => {
    const pem = await makeTestPem();
    const now = 1_750_000_000;
    const jwt = await createAppJwt("12345", pem, now);
    const { header, payload } = decodeJwtParts(jwt);
    expect(header.alg).toBe("RS256");
    expect(header.typ).toBe("JWT");
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(now - 60);
    expect(payload.exp).toBe(now + 540);
  });

  it("accepts GitHub's PKCS#1 PEM (BEGIN RSA PRIVATE KEY)", async () => {
    const pem = await makeTestPem(true);
    expect(pem.startsWith("-----BEGIN RSA PRIVATE KEY-----")).toBe(true);
    const jwt = await createAppJwt("12345", pem, 1_750_000_000);
    expect(decodeJwtParts(jwt).payload.iss).toBe("12345");
  });
});

describe("verifyWebhookSignature", () => {
  const secret = "s3cret";
  const body = new TextEncoder().encode('{"action":"closed"}').buffer;

  async function hmacHex(data: ArrayBuffer, keySecret: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(keySecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, data);
    return Buffer.from(sig).toString("hex");
  }

  it("rejects a wrong secret", async () => {
    const sig = await hmacHex(body, "other");
    await expect(verifyWebhookSignature(body, `sha256=${sig}`, secret)).resolves.toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await hmacHex(body, secret);
    const tampered = new TextEncoder().encode('{"action":"opened"}').buffer;
    await expect(verifyWebhookSignature(tampered, `sha256=${sig}`, secret)).resolves.toBe(false);
  });

  it("rejects an empty or blank secret even with a matching HMAC (no fail-open)", async () => {
    // WebCrypto forbids a zero-length HMAC key, so forge nothing: a signature
    // that IS valid for the real secret must still be rejected when the
    // configured secret is empty/blank.
    const sig = await hmacHex(body, secret);
    await expect(verifyWebhookSignature(body, `sha256=${sig}`, "")).resolves.toBe(false);
    await expect(verifyWebhookSignature(body, `sha256=${sig}`, "   ")).resolves.toBe(false);
  });
});

// ── HTTP client against a mocked fetch (absorbed from client-repo.test.ts) ──
let runtime: ManagedRuntime.ManagedRuntime<GitHubClient, never>;
const routes = new Map<string, unknown>();
type FetchCall = [url: string, init: RequestInit | undefined];
const fetchCalls: FetchCall[] = [];
let fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
const realFetch = globalThis.fetch;

const fetchMock = (url: string, init?: RequestInit): Promise<Response> => {
  fetchCalls.push([url, init]);
  return fetchImpl(url, init);
};

// The installation-token auth flow precedes every API call.
function setupInstallationRoutes(repo: string, installationId = "1") {
  routes.set(`GET https://api.github.com/repos/${repo}/installation`, { id: Number(installationId) });
  routes.set(`POST https://api.github.com/app/installations/${installationId}/access_tokens`, {
    token: "inst-token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

function setupInstallationList(ids: number[]) {
  routes.set("GET https://api.github.com/app/installations?per_page=100", ids.map((id) => ({ id })));
  for (const id of ids) {
    routes.set(`POST https://api.github.com/app/installations/${id}/access_tokens`, {
      token: `inst-token-${id}`,
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function jsonWithLink(data: unknown, link?: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(link ? { link } : {}) },
  });
}

function mockFetch() {
  fetchImpl = (url, init) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    const value = typeof hit === "function" ? (hit as () => unknown)() : hit;
    if (value instanceof Response) return Promise.resolve(value);
    return Promise.resolve(json(value as unknown));
  };
}

beforeAll(async () => {
  // Configure the shared holder (settings > env) so requireConfig passes; a
  // REAL PKCS#1 PEM lets the installation-token flow sign without a crypto mock.
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  setSetting(db, "github_app_id", "12345");
  setSetting(db, "github_private_key", await makeTestPem(true));
  await Effect.runPromise(syncGitHubConfigFromDbAsync(createBunSqliteDriver(db)));
  db.close();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  runtime = ManagedRuntime.make(GitHubClient.Default);
});

afterAll(async () => {
  await runtime.dispose();
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  fetchCalls.length = 0;
  routes.clear();
  mockFetch();
  resetGithubCaches();
});

const call = <A>(fn: (client: InstanceType<typeof GitHubClient>) => Effect.Effect<A, GithubApiError, never>): Promise<A> =>
  runtime.runPromise(
    Effect.gen(function* () {
      const client = yield* GitHubClient;
      return yield* fn(client);
    })
  );

describe("searchRepos pagination and caps", () => {
  it("paginates bounded", async () => {
    setupInstallationList([7]);
    for (let page = 1; page <= 5; page++) {
      routes.set(
        `GET https://api.github.com/installation/repositories?per_page=100&page=${page}`,
        jsonWithLink(
          { repositories: [{ full_name: `acme/repo${page}` }] },
          `<https://api.github.com/installation/repositories?per_page=100&page=${page + 1}>; rel="next"`
        )
      );
    }

    await call((c) => c.searchRepos("repo"));
    const pageCalls = fetchCalls.filter(([url]) => String(url).includes("/installation/repositories"));
    expect(pageCalls.some(([url]) => String(url).includes("page=2"))).toBe(true);
    expect(pageCalls).toHaveLength(5);
  });

  it("local filter + cap 8", async () => {
    setupInstallationList([7]);
    routes.set("GET https://api.github.com/installation/repositories?per_page=100&page=1", {
      repositories: Array.from({ length: 10 }, (_, i) => ({ full_name: `acme/repo${i}` })),
    });
    await expect(call((c) => c.searchRepos("repo"))).resolves.toHaveLength(8);
  });
});

describe("githubFetch robustness", () => {
  it("retries a 429 then succeeds, honoring Retry-After", async () => {
    setupInstallationRoutes("acme/flaky");
    let calls = 0;
    routes.set("GET https://api.github.com/repos/acme/flaky", () => {
      calls++;
      return calls === 1
        ? new Response(JSON.stringify({ message: "slow down" }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "0" },
          })
        : { default_branch: "main" };
    });
    await expect(call((c) => c.getDefaultBranch("acme", "flaky"))).resolves.toBe("main");
    expect(calls).toBe(2);
  });

  it("bounds every githubFetch request with an AbortSignal timeout", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget", { default_branch: "main" });
    await call((c) => c.getDefaultBranch("acme", "widget"));
    const callArgs = fetchCalls.find(([url]) => String(url).endsWith("/repos/acme/widget"));
    expect((callArgs?.[1] as RequestInit | undefined)?.signal).toBeTruthy();
  });
});

// ── file picker allowlist/denylist + caps (absorbed from repo-content.test.ts)
const blob = (path: string, size = 100) => ({ path, type: "blob", size });

describe("selectRepoFiles", () => {
  it("skips dirs (node_modules, .git, dist, build, vendor, .next, coverage, target, .venv) at any depth", () => {
    const tree = [
      blob("src/app.ts"),
      blob("node_modules/lodash/index.js"),
      blob("a/b/.git/config"),
      blob("dist/bundle.js"),
      blob("build/out.bin"),
      blob("vendor/lib.js"),
      blob(".next/static/x.js"),
      blob("coverage/lcov.info"),
      blob("target/debug/x"),
      blob(".venv/bin/python"),
      blob("src/ok.ts"),
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["src/app.ts", "src/ok.ts"]);
  });

  it("skips non-blob tree entries (dirs, submodule commits)", () => {
    const tree = [
      { path: "src", type: "tree" },
      { path: "src/app.ts", type: "blob", size: 10 },
      { path: "vendor/lib", type: "commit", size: 5 },
    ];
    expect(selectRepoFiles(tree).map((f) => f.path)).toEqual(["src/app.ts"]);
  });

  it("caps per-file size: skips blobs larger than maxBytesPerFile without fetching", () => {
    const tree = [blob("big.ts", 300_000), blob("small.ts", 10)];
    expect(selectRepoFiles(tree, { maxBytesPerFile: 256_000 })).toEqual([{ path: "small.ts", size: 10 }]);
  });

  it("caps total bytes across files (tree order, no reordering)", () => {
    const tree = [blob("a.ts", 100), blob("b.ts", 100), blob("c.ts", 100), blob("d.ts", 100)];
    expect(selectRepoFiles(tree, { maxTotalBytes: 250 }).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });

  it("caps file count", () => {
    const tree = [blob("a.ts"), blob("b.ts"), blob("c.ts"), blob("d.ts")];
    expect(selectRepoFiles(tree, { maxFiles: 2 }).map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
  });
});
