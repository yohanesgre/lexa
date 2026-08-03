import { Context, Effect, Layer } from "effect";
import { readFileSync } from "node:fs";
import { GithubApiError } from "../api/errors";
import { createAppJwt, verifyWebhookSignature } from "./crypto";

// ── Config (env) ──
// GITHUB_PRIVATE_KEY: inline PEM (escaped \n). GITHUB_PRIVATE_KEY_FILE: path
// to a .pem file (read at boot — no escaping needed). Inline wins if both set.

function privateKeyFromEnv(): string {
  const inline = process.env.GITHUB_PRIVATE_KEY;
  if (inline) return inline;
  const file = process.env.GITHUB_PRIVATE_KEY_FILE;
  if (file) {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return ""; // unreadable path surfaces as the standard "not configured" error
    }
  }
  return "";
}

export class GitHubConfig extends Context.Tag("GitHubConfig")<
  GitHubConfig,
  {
    readonly appId: string;
    readonly privateKey: string;    // PEM, for app JWT signing
    readonly webhookSecret: string; // HMAC-SHA-256 for X-Hub-Signature-256
  }
>() {}

export const GitHubConfigLive = Layer.succeed(GitHubConfig, {
  appId: process.env.GITHUB_APP_ID ?? "",
  privateKey: privateKeyFromEnv(),
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET ?? "",
});

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
      message: "GitHub App is not configured — set GITHUB_APP_ID and GITHUB_PRIVATE_KEY (or GITHUB_PRIVATE_KEY_FILE)",
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

      verifyWebhookSignature: (rawBody: ArrayBuffer, signatureHeader: string | null): Effect.Effect<boolean, never> =>
        Effect.promise(() => verifyWebhookSignature(rawBody, signatureHeader, config.webhookSecret)),
    };
  }),
}) {}
