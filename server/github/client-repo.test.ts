import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { Effect, ManagedRuntime } from "effect";
import { Database } from "bun:sqlite";
import { setSetting } from "../db/settings";
import { GithubApiError } from "../api/errors";
import { GitHubClient, syncGitHubConfigFromDb, resetGithubCaches } from "./client";

// The installation-token flow signs an app JWT before any fetch — stub it so
// the happy path never touches real crypto (the fake PEM below would reject).
vi.mock("./crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./crypto")>();
  return { ...actual, createAppJwt: vi.fn(async () => "fake-jwt") };
});

const fetchMock = vi.fn();
const routes = new Map<string, unknown>();

// The installation-token auth flow precedes every API call.
function setupInstallationRoutes(repo: string, installationId = "1") {
  routes.set(`GET https://api.github.com/repos/${repo}/installation`, { id: Number(installationId) });
  routes.set(`POST https://api.github.com/app/installations/${installationId}/access_tokens`, {
    token: "inst-token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function mockFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const key = `${init?.method ?? "GET"} ${url}`;
    const hit = routes.get(key) ?? routes.get(`GET ${url}`);
    if (hit === undefined) return Promise.reject(new Error(`unmocked: ${key}`));
    const value = typeof hit === "function" ? (hit as () => unknown)() : hit;
    if (value instanceof Response) return Promise.resolve(value);
    return Promise.resolve(json(value as unknown));
  });
}

let runtime: ManagedRuntime.ManagedRuntime<GitHubClient, never>;

beforeAll(async () => {
  // Configure the shared holder (settings > env) so requireConfig passes.
  const db = new Database(":memory:");
  db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))");
  setSetting(db, "github_app_id", "12345");
  setSetting(db, "github_private_key", "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----");
  syncGitHubConfigFromDb(db);
  db.close();
  runtime = ManagedRuntime.make(GitHubClient.Default);
});

afterAll(async () => {
  await runtime.dispose();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
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

describe("getDefaultBranch", () => {
  it("returns the repo's default branch", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget", { default_branch: "main" });
    await expect(call((c) => c.getDefaultBranch("acme", "widget"))).resolves.toBe("main");
  });

  it("missing default_branch → GithubApiError", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget", { name: "widget" });
    await expect(call((c) => c.getDefaultBranch("acme", "widget"))).rejects.toMatchObject({ message: expect.stringContaining("no default_branch") });
  });

  it("HTTP error → GithubApiError with status", async () => {
    setupInstallationRoutes("acme/missing");
    routes.set("GET https://api.github.com/repos/acme/missing", json({ message: "Not Found" }, 404));
    await expect(call((c) => c.getDefaultBranch("acme", "missing"))).rejects.toMatchObject({
      message: expect.stringContaining("404"),
    });
  });
});

describe("getRepoFileTree", () => {
  it("returns blob/tree entries with sizes", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget/git/trees/main?recursive=1", {
      sha: "abc",
      truncated: false,
      tree: [
        { path: "src", type: "tree" },
        { path: "src/index.ts", type: "blob", size: 120 },
        { path: "src/util.ts", type: "blob", size: 80 },
      ],
    });
    await expect(call((c) => c.getRepoFileTree("acme", "widget", "main"))).resolves.toEqual([
      { path: "src", type: "tree" },
      { path: "src/index.ts", type: "blob", size: 120 },
      { path: "src/util.ts", type: "blob", size: 80 },
    ]);
  });

  it("truncated tree is tolerated (treated as full)", async () => {
    setupInstallationRoutes("acme/big");
    routes.set("GET https://api.github.com/repos/acme/big/git/trees/main?recursive=1", {
      sha: "abc", truncated: true,
      tree: [{ path: "a.ts", type: "blob", size: 1 }],
    });
    await expect(call((c) => c.getRepoFileTree("acme", "big", "main"))).resolves.toHaveLength(1);
  });

  it("HTTP error → GithubApiError", async () => {
    setupInstallationRoutes("acme/private");
    routes.set("GET https://api.github.com/repos/acme/private/git/trees/main?recursive=1", json({ message: "Not Found" }, 404));
    await expect(call((c) => c.getRepoFileTree("acme", "private", "main"))).rejects.toMatchObject({ message: expect.stringContaining("tree lookup failed") });
  });
});

describe("getRepoFileContent", () => {
  const b64 = (s: string) => Buffer.from(s).toString("base64");

  it("decodes base64 content to utf8", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget/contents/src/index.ts", {
      content: b64("export const x = 1;\n// café"),
      encoding: "base64",
    });
    await expect(call((c) => c.getRepoFileContent("acme", "widget", "src/index.ts"))).resolves.toBe("export const x = 1;\n// café");
  });

  it("URL-encodes each path segment (spaces)", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget/contents/docs/my%20notes.md", {
      content: b64("# Notes"),
    });
    // Slashes stay literal (path separators); only special chars in segment
    // names are encoded (the space → %20).
    await expect(call((c) => c.getRepoFileContent("acme", "widget", "docs/my notes.md"))).resolves.toBe("# Notes");
  });

  it("missing content field → GithubApiError", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget/contents/large.bin", { encoding: "base64" });
    await expect(call((c) => c.getRepoFileContent("acme", "widget", "large.bin"))).rejects.toMatchObject({ message: expect.stringContaining("missing base64 body") });
  });

  it("HTTP error → GithubApiError", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget/contents/nope.ts", json({ message: "Not Found" }, 404));
    await expect(call((c) => c.getRepoFileContent("acme", "widget", "nope.ts"))).rejects.toMatchObject({
      message: expect.stringContaining("404"),
    });
  });
});

describe("searchRepos", () => {
  function setupInstallationList() {
    routes.set("GET https://api.github.com/app/installations?per_page=100", [{ id: 7 }]);
    routes.set("POST https://api.github.com/app/installations/7/access_tokens", {
      token: "inst-token",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
  }

  function authHeaderFor(segment: string): string | undefined {
    const callArgs = fetchMock.mock.calls.find(([url]) => String(url).includes(segment));
    const headers = (callArgs?.[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined;
    return headers?.Authorization;
  }

  it("authenticates the search request with an installation token", async () => {
    setupInstallationList();
    routes.set("GET https://api.github.com/search/repositories?q=wid&per_page=8&sort=stars", { items: [{ full_name: "acme/widget" }] });
    await expect(call((c) => c.searchRepos("wid"))).resolves.toEqual(["acme/widget"]);
    expect(authHeaderFor("/search/repositories")).toBe("Bearer inst-token");
  });

  it("falls back to /installation/repositories and filters locally when search is unusable", async () => {
    setupInstallationList();
    routes.set("GET https://api.github.com/search/repositories?q=wid&per_page=8&sort=stars", json({ message: "Forbidden" }, 403));
    routes.set("GET https://api.github.com/installation/repositories?per_page=100", {
      repositories: [{ full_name: "acme/widget" }, { full_name: "acme/other" }],
    });
    await expect(call((c) => c.searchRepos("wid"))).resolves.toEqual(["acme/widget"]);
    expect(authHeaderFor("/installation/repositories")).toBe("Bearer inst-token");
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

  it("does not retry a plain 4xx", async () => {
    setupInstallationRoutes("acme/missing");
    routes.set("GET https://api.github.com/repos/acme/missing", json({ message: "Not Found" }, 404));
    await expect(call((c) => c.getDefaultBranch("acme", "missing"))).rejects.toMatchObject({
      message: expect.stringContaining("404"),
    });
  });

  it("bounds every githubFetch request with an AbortSignal timeout", async () => {
    setupInstallationRoutes("acme/widget");
    routes.set("GET https://api.github.com/repos/acme/widget", { default_branch: "main" });
    await call((c) => c.getDefaultBranch("acme", "widget"));
    const callArgs = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/repos/acme/widget"));
    expect((callArgs?.[1] as RequestInit | undefined)?.signal).toBeTruthy();
  });
});

describe("verifyWebhookSignature (client wrapper)", () => {
  it("returns false when no webhook secret is configured", async () => {
    const body = new TextEncoder().encode('{"action":"closed"}').buffer;
    await expect(call((c) => c.verifyWebhookSignature(body, "sha256=deadbeef"))).resolves.toBe(false);
    await expect(call((c) => c.verifyWebhookSignature(body, null))).resolves.toBe(false);
  });
});
