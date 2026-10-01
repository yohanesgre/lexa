// GitHub App Manifest flow — the in-app "Connect GitHub App" path (LX-6).
//
// The server builds the manifest, the admin posts it to GitHub, GitHub creates
// the App and redirects back with a one-time `code` + `state`; this module
// owns the manifest definition, the CSRF/single-use state (a settings row, no
// new table — D4), the code exchange, and the permission assert.
//
// State: one settings row (`github_manifest_state`) holding JSON
// `{ value, expiresMs }`, ~10 min TTL, single-use. Unknown, already-used,
// expired, and mismatched all fail with the SAME error (no oracle).

import { Effect } from "effect";
import { queryAll, run, type DbDriver, ConstraintViolation, DbError } from "../db/db";
import {
  GithubManifestStateInvalid,
  GithubManifestExchangeFailed,
  GithubManifestPermissionsDenied,
} from "../api/errors";

export const MANIFEST_STATE_SETTING_KEY = "github_manifest_state";
export const MANIFEST_STATE_TTL_MS = 10 * 60 * 1000;

// The exact permissions the App needs. Content Read backs the Runtime context
// file tree; Issues Read+Write backs two-way sync; Metadata is always present.
export const REQUIRED_MANIFEST_PERMISSIONS = Object.freeze({
  issues: "write",
  metadata: "read",
  contents: "read",
} as const);

export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface ManifestAppCredentials {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  // Present only when GitHub reports it (the current conversion payload does
  // not) — absent means "no signal", never "permission denied".
  permissions?: Record<string, string>;
}

// Deterministic manifest for a public base URL. `{PUBLIC_URL}` is the same
// source as invite/share links (resolvePublicUrl), so a tunneled dev host
// works without extra config.
export function buildManifest(publicUrl: string): GithubAppManifest {
  const base = publicUrl.replace(/\/+$/, "");
  return {
    name: "Lexa",
    url: base,
    hook_attributes: { url: `${base}/api/webhooks/github`, active: true },
    redirect_url: `${base}/settings/github/callback`,
    public: false,
    default_permissions: { ...REQUIRED_MANIFEST_PERMISSIONS },
    default_events: ["issues"],
  };
}

// GitHub's App-creation form target; `state` rides the query string and is
// echoed back to `redirect_url` unchanged.
export function manifestPostUrl(state: string): string {
  return `https://github.com/settings/apps/new?state=${encodeURIComponent(state)}`;
}

function randomState(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

const writeState = (driver: DbDriver, payload: string): Effect.Effect<void, ConstraintViolation | DbError> =>
  run(
    driver,
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
    MANIFEST_STATE_SETTING_KEY,
    payload
  ).pipe(Effect.asVoid);

// Issues a fresh single-use state. A new attempt overwrites any previous one.
export function createManifestState(driver: DbDriver): Effect.Effect<string, ConstraintViolation | DbError> {
  return Effect.gen(function* () {
    const value = randomState();
    const payload = JSON.stringify({ value, expiresMs: Date.now() + MANIFEST_STATE_TTL_MS });
    yield* writeState(driver, payload);
    return value;
  });
}

// Verifies AND consumes the state in one atomic DELETE … RETURNING. The row is
// deleted on every attempt (match or not) so a lost/leaked link gets exactly
// one chance, and a delete failure surfaces as DbError (never swallowed). A
// missing row is the same invalid-state path; the stored value is regenerated
// only by a fresh manifest call.
export function consumeManifestState(
  driver: DbDriver,
  state: string
): Effect.Effect<void, GithubManifestStateInvalid | DbError> {
  return Effect.gen(function* () {
    const rows = yield* queryAll<{ value: string }>(
      driver,
      "DELETE FROM settings WHERE key = ? RETURNING value",
      MANIFEST_STATE_SETTING_KEY
    );

    const stored = rows[0]?.value;
    if (stored === undefined) {
      return yield* Effect.fail(new GithubManifestStateInvalid());
    }

    let parsed: { value?: unknown; expiresMs?: unknown };
    try {
      parsed = JSON.parse(stored) as { value?: unknown; expiresMs?: unknown };
    } catch {
      return yield* Effect.fail(new GithubManifestStateInvalid());
    }

    if (typeof parsed.value !== "string" || parsed.value === "" || parsed.value !== state) {
      return yield* Effect.fail(new GithubManifestStateInvalid());
    }
    if (
      typeof parsed.expiresMs !== "number" ||
      !Number.isFinite(parsed.expiresMs) ||
      parsed.expiresMs < Date.now()
    ) {
      return yield* Effect.fail(new GithubManifestStateInvalid());
    }
    return yield* Effect.void;
  });
}

// Defensive check against the permissions GitHub reports after creation. A
// missing report is not a failure (the manifest is the authority); a report
// that lacks a required scope is.
export function assertRequiredPermissions(
  permissions: Record<string, unknown> | null | undefined
): Effect.Effect<void, GithubManifestPermissionsDenied> {
  if (permissions === null || permissions === undefined) return Effect.void;
  for (const [key, level] of Object.entries(REQUIRED_MANIFEST_PERMISSIONS)) {
    if (permissions[key] !== level) return Effect.fail(new GithubManifestPermissionsDenied());
  }
  return Effect.void;
}

// Exchange the one-time code for the App credentials. No retry: a duplicated
// exchange cannot succeed (the code is single-use) and would only burn time.
export function exchangeManifestCode(code: string): Effect.Effect<ManifestAppCredentials, GithubManifestExchangeFailed> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "lexa",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        throw new Error(`manifest exchange failed: ${res.status}`);
      }
      const body = (await res.json()) as {
        id?: unknown;
        slug?: unknown;
        pem?: unknown;
        webhook_secret?: unknown;
        permissions?: unknown;
      };
      const appId =
        typeof body.id === "number" ? String(body.id) : typeof body.id === "string" ? body.id : "";
      const slug = typeof body.slug === "string" ? body.slug : "";
      const privateKey = typeof body.pem === "string" ? body.pem : "";
      const webhookSecret = typeof body.webhook_secret === "string" ? body.webhook_secret : "";
      if (appId === "" || privateKey === "" || webhookSecret === "") {
        throw new Error("manifest exchange response missing credentials");
      }
      const permissions =
        typeof body.permissions === "object" && body.permissions !== null
          ? (body.permissions as Record<string, string>)
          : undefined;
      return { appId, slug, privateKey, webhookSecret, ...(permissions === undefined ? {} : { permissions }) };
    },
    catch: (e) =>
      new GithubManifestExchangeFailed({
        message: e instanceof Error ? e.message : String(e),
      }),
  });
}
