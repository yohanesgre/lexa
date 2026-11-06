import { createIsomorphicFn } from "@tanstack/react-start";
import type { LexaUser } from "../../shared/types";

// Better Auth session surface (BE pins better-auth 1.6.27; the handler is
// mounted at /api/auth/*). The FE talks to it over plain fetch — the cookie
// (httpOnly, secure, 7d sliding) is managed by the browser, no client SDK.

export interface SessionUser extends Omit<LexaUser, "lastSeen"> {
  // `lastSeen` is an app-managed column (`users.last_seen`), not a Better Auth
  // additional field, so it is absent from get-session and sign-in payloads.
  lastSeen?: LexaUser["lastSeen"];
}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

export interface SessionResponse {
  session: AuthSession | null;
  user: SessionUser | null;
}

// Better Auth `/sign-in/email` body: the raw session token + user, NOT the
// get-session shape (no `session` field) and the user carries no `lastSeen`
// (that column is app-managed, not a Better Auth additional field). Consumers
// must never cast this to SessionResponse — seed `{ session: null, user }`
// and refetch get-session.
export type SignInUser = Omit<SessionUser, "lastSeen">;

export interface SignInResponse {
  redirect: boolean;
  token?: string | undefined;
  url?: string | undefined;
  user?: SignInUser | undefined;
}

const AUTH_BASE = "/api/auth";

// Root beforeLoad and useAuthBounce both ask for the session on load/navigation
// (and useSession may join them), so a short in-flight/TTL window shares one
// GET /api/auth/get-session. Auth mutations clear it before and after their
// request, so a sign-in/out is never observed through a stale pre- or
// in-flight-mutation response. The TanStack Query cache is deliberately
// untouched.
const SESSION_FETCH_TTL_MS = 1500;
let sessionFetch: { at: number; promise: Promise<SessionResponse> } | null = null;

function clearSessionFetch(): void {
  sessionFetch = null;
}

async function requestSession(): Promise<SessionResponse> {
  try {
    const res = await fetch(`${AUTH_BASE}/get-session`, { credentials: "include" });
    if (!res.ok) return { session: null, user: null };
    // Unauthenticated get-session returns HTTP 200 with body null — normalize
    // it so callers can read `.session` without a crash.
    const data = (await res.json()) as SessionResponse | null;
    return data ?? { session: null, user: null };
  } catch {
    return { session: null, user: null };
  }
}

export function fetchSessionClient(): Promise<SessionResponse> {
  const now = Date.now();
  if (sessionFetch && now - sessionFetch.at < SESSION_FETCH_TTL_MS) return sessionFetch.promise;
  const promise = requestSession();
  sessionFetch = { at: now, promise };
  return promise;
}

// SSR cookie forwarding lives in auth-session.server.ts (server-only module);
// on the client the server branch is stubbed out by the TanStack Start plugin.
export const getSession = createIsomorphicFn()
  .server(async (): Promise<SessionResponse> => {
    const { fetchSessionServer } = await import("./auth-session.server");
    return fetchSessionServer();
  })
  .client(fetchSessionClient);

// Auth errors carry the Better Auth code and the wrapper HTTP status as extra
// Error fields; narrow them instead of casting at call sites.
export function authErrorCode(err: unknown): string | undefined {
  if (err instanceof Error && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

export function authErrorStatus(err: unknown): number | undefined {
  if (err instanceof Error && "status" in err && typeof err.status === "number") return err.status;
  return undefined;
}

interface AuthErrorPayload {
  message?: string | undefined;
  code?: string | undefined;
  // Native Better Auth errors carry `message`/`code` at the top level; the
  // app's wrapper uses the `{ error: { code, message } }` envelope.
  error?: string | { code?: string | undefined; message?: string | undefined } | undefined;
}

async function authRequest(path: string, body: unknown): Promise<unknown> {
  // Any auth mutation changes the session surface; the next get-session must
  // observe the post-mutation cookie, never a pre-mutation cached response.
  // Clear before the request and again after it: a get-session racing the
  // mutation can cache its in-window result, which is stale once the cookie
  // (and possibly the session row) changed.
  clearSessionFetch();
  try {
    const res = await fetch(`${AUTH_BASE}${path}`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as AuthErrorPayload;
      const envelope = typeof data.error === "object" && data.error !== null ? data.error : undefined;
      const legacyMessage = typeof data.error === "string" ? data.error : undefined;
      const err = new Error(data.message ?? envelope?.message ?? legacyMessage ?? `HTTP ${res.status}`) as Error & { code?: string; status?: number };
      const code = data.code ?? envelope?.code ?? legacyMessage;
      if (code !== undefined) err.code = code;
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return undefined;
    return res.json();
  } finally {
    clearSessionFetch();
  }
}

export function signInEmail(input: { email: string; password: string }): Promise<SignInResponse> {
  return authRequest("/sign-in/email", input) as Promise<SignInResponse>;
}

export function signOut(): Promise<void> {
  return authRequest("/sign-out", {}) as Promise<void>;
}

// Keyless self-service recovery. The server acknowledges before any account
// lookup or send, so provider outcome never reaches the client.
export interface PasswordResetRequestResult {
  status: boolean;
  message: string;
}

export function requestPasswordReset(input: { email: string }): Promise<PasswordResetRequestResult> {
  return authRequest("/request-password-reset", input) as Promise<PasswordResetRequestResult>;
}

// Verification-token password set (/set-password?token=). Both token kinds are
// consumed here: self-service reset tokens (better-auth native, 30 minutes)
// and admin-issued set-password links (7 days). It sets the password and
// revokes existing sessions, including any session current on this device; the
// signed session cache can stay stale for up to the documented 300s window,
// so the set-password surface treats the token, not the session, as authority.
// It returns `{ status: true }` and seeds NO session cookie — the user must
// sign in afterwards. Workspace invitation links (/invite?token=) live in a
// different table and use acceptInvite below — the two token kinds are not
// interchangeable.
export function setPassword(input: { newPassword: string; token: string }): Promise<{ status: boolean }> {
  return authRequest("/reset-password", input) as Promise<{ status: boolean }>;
}

// Workspace invitation accept (POST /api/auth/invite/accept — keyless,
// session-less, the token is the auth). Creates the member account and
// stamps accepted_at; establishes NO session — the caller signs in with
// the returned email + chosen password afterwards.
export function acceptInvite(input: { token: string; name: string; password: string }): Promise<{ status: boolean; email: string }> {
  return authRequest("/invite/accept", input) as Promise<{ status: boolean; email: string }>;
}

export function changePassword(input: { currentPassword: string; newPassword: string; revokeOtherSessions: boolean }): Promise<void> {
  return authRequest("/change-password", input) as Promise<void>;
}
