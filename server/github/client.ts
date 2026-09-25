import { Context, Effect, Layer } from "effect";
import type { Database } from "bun:sqlite";
import { queryFirst, type DbDriver } from "../db/db";
import { GithubApiError } from "../api/errors";
import { createAppJwt, verifyWebhookSignature } from "./crypto";

// ── Config (DB only at runtime) ──
// The settings table (github_app_id / github_private_key / github_webhook_secret)
// is the SINGLE source of truth. Env (GITHUB_APP_ID / GITHUB_PRIVATE_KEY /
// GITHUB_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET) is a first-boot bootstrap
// only — mirrorSettingsFromEnv copies it into the DB once at boot, and the
// runtime never reads env again.

export class GitHubConfig extends Context.Tag("GitHubConfig")<
  GitHubConfig,
  {
    readonly appId: string;
    readonly privateKey: string;    // PEM, for app JWT signing
    readonly webhookSecret: string; // HMAC-SHA-256 for X-Hub-Signature-256
  }
>() {}

// ── Config holder (module scope) ──
// GitHubConfigLive serves this MUTABLE holder object (never replaced): every
// consumer that captured the reference — GitHubClient service effects, the
// webhook verifier runtime — reads the live fields on every call, so a
// Settings save applies immediately without rebuilding any runtime.

const configHolder: { appId: string; privateKey: string; webhookSecret: string } = {
  appId: "",
  privateKey: "",
  webhookSecret: "",
};

export const GitHubConfigLive = Layer.effect(GitHubConfig, Effect.sync(() => configHolder));

// Applies the DB-configured values (DB only; empty rows = not configured) to
// the holder — called at boot (after the env mirror) and after every
// PUT /api/settings/github.
export function syncGitHubConfigFromDb(db: Database): void {
  configHolder.appId = nonEmptySetting(
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("github_app_id") as { value: string } | null)?.value ?? null
  );
  configHolder.privateKey = nonEmptySetting(
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("github_private_key") as { value: string } | null)?.value ?? null
  );
  configHolder.webhookSecret = nonEmptySetting(
    (db.prepare("SELECT value FROM settings WHERE key = ?").get("github_webhook_secret") as { value: string } | null)?.value ?? null
  );
}

function nonEmptySetting(v: string | null): string {
  return v !== null && v.trim() !== "" ? v : "";
}

// Async port of syncGitHubConfigFromDb over a DbDriver (Workers/D1 path).
// Same holder, same DB-only semantics — missing rows read as "".
export function syncGitHubConfigFromDbAsync(driver: DbDriver): Effect.Effect<void, never> {
  const read = (key: string): Effect.Effect<string, never> =>
    queryFirst<{ value: string }>(driver, "SELECT value FROM settings WHERE key = ?", key).pipe(
      Effect.map((row) => nonEmptySetting(row.value)),
      Effect.catchAll(() => Effect.succeed(""))
    );
  return Effect.gen(function* () {
    configHolder.appId = yield* read("github_app_id");
    configHolder.privateKey = yield* read("github_private_key");
    configHolder.webhookSecret = yield* read("github_webhook_secret");
  });
}

// Drops cached installation ids and tokens — a credential/app change must not
// keep signing with the previous app. Called after every Settings save.
export function resetGithubCaches(): void {
  tokenCache.clear();
  installationCache.clear();
}

// ── JWT (RS256 via Web Crypto) — see ./crypto ──

// ── Webhook signature verification — see ./crypto ──

// ── Installation token cache ──
// MODULE scope (outside the Effect layer): a per-request layer would mint a
// fresh token per request. Tokens live 1h; we refresh at 50 min.

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms — refresh when within 10 min of expiry
}

const tokenCache = new Map<string, CachedToken>();
const installationCache = new Map<string, string>(); // repo "owner/name" → installation id

const API_BASE = "https://api.github.com";
const API_HEADERS = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "lexa",
};

interface GithubIssueApiShape {
  node_id: string;
  number: number;
  state: "open" | "closed";
  title: string;
  body?: string;
}

const GITHUB_TIMEOUT_MS = 15_000;
const GITHUB_MAX_RETRIES = 2;
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD"]);

function retryAfterMs(res: Response, attempt: number): number {
  const header = Number(res.headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return Math.min(header * 1000, 8_000);
  return 250 * 2 ** attempt;
}

// One network chokepoint for the client: every call is bounded by a timeout,
// and idempotent (GET/HEAD) requests retry a small number of times on 429/5xx
// with backoff that honors Retry-After. Non-idempotent calls (POST/PATCH) are
// never retried — a duplicate write is worse than a surfaced error.
async function githubFetch(config: GitHubConfig["Type"], path: string, init: RequestInit): Promise<Response> {
  requireConfig(config);
  const url = `${API_BASE}${path}`;
  const method = (init.method ?? "GET").toUpperCase();
  const retriable = IDEMPOTENT_METHODS.has(method);
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(GITHUB_TIMEOUT_MS) });
    if (!retriable || attempt >= GITHUB_MAX_RETRIES || (res.status !== 429 && res.status < 500)) return res;
    await new Promise((resolve) => setTimeout(resolve, retryAfterMs(res, attempt)));
    attempt++;
  }
}

function requireConfig(config: GitHubConfig["Type"]): void {
  if (!config.appId || !config.privateKey) {
    throw new GithubApiError({
      message: "GitHub App is not configured — set it in Settings → GitHub Sync or via GITHUB_APP_ID/GITHUB_PRIVATE_KEY env",
    });
  }
}

async function installationIdFor(config: GitHubConfig["Type"], repo: string): Promise<string> {
  requireConfig(config);
  const cached = installationCache.get(repo);
  if (cached) return cached;
  const jwt = await createAppJwt(config.appId, config.privateKey);
  const res = await fetch(`${API_BASE}/repos/${repo}/installation`, {
    headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new GithubApiError({
      message: `GitHub installation lookup failed for ${repo}: ${res.status} ${await res.text().catch(() => "")}`,
    });
  }
  const body = (await res.json()) as { id?: number };
  if (typeof body.id !== "number") {
    throw new GithubApiError({ message: `GitHub installation lookup returned no id for ${repo}` });
  }
  installationCache.set(repo, String(body.id));
  return String(body.id);
}

async function installationTokenForId(config: GitHubConfig["Type"], installationId: string): Promise<string> {
  const cached = tokenCache.get(installationId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const jwt = await createAppJwt(config.appId, config.privateKey);
  const res = await fetch(`${API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new GithubApiError({
      message: `GitHub installation token failed: ${res.status} ${await res.text().catch(() => "")}`,
    });
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new GithubApiError({ message: "GitHub installation token response missing token" });
  }
  const expiresMs = body.expires_at ? Date.parse(body.expires_at) : Date.now() + 60 * 60 * 1000;
  tokenCache.set(installationId, { token: body.token, expiresAt: expiresMs - 10 * 60 * 1000 });
  return body.token;
}

async function installationTokenFor(config: GitHubConfig["Type"], repo: string): Promise<string> {
  return installationTokenForId(config, await installationIdFor(config, repo));
}

// App-token listing of this App's installations (the repo-search type-ahead
// has no repo to resolve one from).
async function listInstallations(config: GitHubConfig["Type"]): Promise<string[]> {
  requireConfig(config);
  const jwt = await createAppJwt(config.appId, config.privateKey);
  const res = await githubFetch(config, "/app/installations?per_page=100", {
    method: "GET",
    headers: { ...API_HEADERS, Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) {
    throw new GithubApiError({
      message: `GitHub installation list failed: ${res.status} ${await res.text().catch(() => "")}`,
    });
  }
  const body = (await res.json()) as { id?: number }[];
  return body.filter((i): i is { id: number } => typeof i.id === "number").map((i) => String(i.id));
}

// Fallback for the repo search: every repo the App can see, filtered locally.
async function installedRepoNames(config: GitHubConfig["Type"], installationIds: string[]): Promise<string[]> {
  const names: string[] = [];
  for (const id of installationIds) {
    const token = await installationTokenForId(config, id);
    const res = await githubFetch(config, "/installation/repositories?per_page=100", {
      method: "GET",
      headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
    });
    if (!res.ok) continue;
    const body = (await res.json()) as { repositories?: { full_name?: string }[] };
    for (const repo of body.repositories ?? []) {
      if (typeof repo.full_name === "string") names.push(repo.full_name);
    }
  }
  return names;
}

// ── Client service ──

export class GitHubClient extends Effect.Service<GitHubClient>()("GitHubClient", {
  dependencies: [GitHubConfigLive],
  effect: Effect.gen(function* () {
    const config = yield* GitHubConfig;

    const authedFetch = async (repo: string, path: string, init: RequestInit): Promise<Response> => {
      const token = await installationTokenFor(config, repo);
      return githubFetch(config, path, {
        ...init,
        headers: { ...API_HEADERS, Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
    };

    return {
      createIssue: (repo: string, title: string, body: string): Effect.Effect<{ nodeId: string; number: number }, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(repo, `/repos/${repo}/issues`, {
              method: "POST",
              body: JSON.stringify({ title, body }),
            });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub create issue failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const issue = (await res.json()) as GithubIssueApiShape;
            return { nodeId: issue.node_id, number: issue.number };
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      updateIssueState: (repo: string, issueNumber: number, state: "open" | "closed"): Effect.Effect<void, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(repo, `/repos/${repo}/issues/${issueNumber}`, {
              method: "PATCH",
              body: JSON.stringify({ state }),
            });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub update issue state failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      updateIssueContent: (repo: string, issueNumber: number, content: { title: string; body: string }): Effect.Effect<void, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(repo, `/repos/${repo}/issues/${issueNumber}`, {
              method: "PATCH",
              body: JSON.stringify(content),
            });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub update issue content failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      getIssue: (repo: string, issueNumber: number): Effect.Effect<{ nodeId: string; number: number; state: "open" | "closed"; title: string; body: string }, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(repo, `/repos/${repo}/issues/${issueNumber}`, { method: "GET" });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub get issue failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const issue = (await res.json()) as GithubIssueApiShape;
            return { nodeId: issue.node_id, number: issue.number, state: issue.state, title: issue.title, body: issue.body ?? "" };
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // Recent issues of a repo (open + closed), newest first, capped at
      // per_page=100 — the autocomplete backing. Core API (not the search
      // API): no index lag, no 30/min search quota. Pull requests are
      // excluded (the /issues endpoint includes them with a pull_request key).
      listIssues: (owner: string, repo: string): Effect.Effect<{ number: number; title: string; state: "open" | "closed" }[], GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(`${owner}/${repo}`, `/repos/${owner}/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`, {
              method: "GET",
            });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub list issues failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const items = (await res.json()) as { number: number; title: string; state: "open" | "closed"; pull_request?: unknown }[];
            const out: { number: number; title: string; state: "open" | "closed" }[] = [];
            for (const i of items) {
              if (!i.pull_request) out.push({ number: i.number, title: i.title, state: i.state });
            }
            return out;
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // Type-ahead repo search for the Settings Linked Repos add-row. Search
      // API (30 req/min authed) — debounced client-side; only repos the App
      // is installed on appear (the App never sees beyond its install scope).
      searchRepos: (query: string): Effect.Effect<string[], GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const installations = await listInstallations(config);
            const first = installations[0];
            if (first !== undefined) {
              const token = await installationTokenForId(config, first);
              const res = await githubFetch(config, `/search/repositories?q=${encodeURIComponent(query)}&per_page=8&sort=stars`, {
                method: "GET",
                headers: { ...API_HEADERS, Authorization: `Bearer ${token}` },
              });
              if (res.ok) {
                const body = (await res.json()) as { items?: { full_name: string }[] };
                return (body.items ?? []).map((i) => i.full_name);
              }
            }
            // Installation tokens may not be able to query the search API (or
            // no installation exists yet): fall back to the App's installed
            // repositories, filtered locally.
            const all = await installedRepoNames(config, installations);
            const q = query.trim().toLowerCase();
            return all.filter((name) => name.toLowerCase().includes(q)).slice(0, 8);
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // ── Repo content (Runtime context — Contents: Read) ──

      getDefaultBranch: (owner: string, repo: string): Effect.Effect<string, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(`${owner}/${repo}`, `/repos/${owner}/${repo}`, { method: "GET" });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub repo lookup failed for ${owner}/${repo}: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const body = (await res.json()) as { default_branch?: string };
            if (!body.default_branch) {
              throw new GithubApiError({ message: `GitHub repo lookup returned no default_branch for ${owner}/${repo}` });
            }
            return body.default_branch;
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // Recursive tree for the branch. `truncated` (huge repos) is tolerated —
      // the selection caps bound what gets fetched regardless.
      getRepoFileTree: (owner: string, repo: string, branch: string): Effect.Effect<Array<{ path: string; type: string; size?: number }>, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(`${owner}/${repo}`, `/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`, { method: "GET" });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub tree lookup failed for ${owner}/${repo}@${branch}: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const body = (await res.json()) as { tree?: Array<{ path?: string; type?: string; size?: number }> };
            return (body.tree ?? [])
              .filter((t): t is { path: string; type: string; size?: number } => typeof t.path === "string" && typeof t.type === "string")
              .map((t) => ({ path: t.path, type: t.type, ...(t.size !== undefined ? { size: t.size } : {}) }));
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // Base64-encoded contents API (per-segment URL-encoded path).
      getRepoFileContent: (owner: string, repo: string, path: string): Effect.Effect<string, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const encodedPath = path.split("/").map(encodeURIComponent).join("/");

            const res = await authedFetch(`${owner}/${repo}`, `/repos/${owner}/${repo}/contents/${encodedPath}`, { method: "GET" });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub content fetch failed for ${owner}/${repo}:${path}: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const body = (await res.json()) as { content?: string };
            if (typeof body.content !== "string") {
              throw new GithubApiError({ message: `GitHub content response missing base64 body for ${owner}/${repo}:${path}` });
            }
            return Buffer.from(body.content, "base64").toString("utf8");
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      verifyWebhookSignature: (rawBody: ArrayBuffer, signatureHeader: string | null): Effect.Effect<boolean, never> =>
        // Belt-and-braces: refuse up front when no secret is configured rather
        // than relying on the HMAC(empty) guard alone.
        config.webhookSecret.trim() === ""
          ? Effect.succeed(false)
          : Effect.promise(() => verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret)),
    };
  }),
}) {}
