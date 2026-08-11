import { Context, Effect, Layer } from "effect";
import { Database } from "bun:sqlite";
import { getSetting } from "../db/settings";
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
  const nonEmpty = (v: string | null): string => (v !== null && v.trim() !== "" ? v : "");
  configHolder.appId = nonEmpty(getSetting(db, "github_app_id"));
  configHolder.privateKey = nonEmpty(getSetting(db, "github_private_key"));
  configHolder.webhookSecret = nonEmpty(getSetting(db, "github_webhook_secret"));
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
}

async function githubFetch(config: GitHubConfig["Type"], path: string, init: RequestInit): Promise<Response> {
  requireConfig(config);
  return fetch(`${API_BASE}${path}`, init);
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

async function installationTokenFor(config: GitHubConfig["Type"], repo: string): Promise<string> {
  const installationId = await installationIdFor(config, repo);
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

      getIssue: (repo: string, issueNumber: number): Effect.Effect<{ nodeId: string; number: number; state: "open" | "closed"; title: string }, GithubApiError> =>
        Effect.tryPromise({
          try: async () => {
            const res = await authedFetch(repo, `/repos/${repo}/issues/${issueNumber}`, { method: "GET" });
            if (!res.ok) {
              throw new GithubApiError({
                message: `GitHub get issue failed: ${res.status} ${await res.text().catch(() => "")}`,
              });
            }
            const issue = (await res.json()) as GithubIssueApiShape;
            return { nodeId: issue.node_id, number: issue.number, state: issue.state, title: issue.title };
          },
          catch: (e) => (e instanceof GithubApiError ? e : new GithubApiError({ message: String(e) })),
        }),

      // ── Repo content (Forge context — Contents: Read) ──

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
        Effect.promise(() => verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret)),
    };
  }),
}) {}
