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

async function fetchSessionClient(): Promise<SessionResponse> {
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

// SSR cookie forwarding lives in auth-session.server.ts (server-only module);
// on the client the server branch is stubbed out by the TanStack Start plugin.
export const getSession = createIsomorphicFn()
  .server(async (): Promise<SessionResponse> => {
    const { fetchSessionServer } = await import("./auth-session.server");
    return fetchSessionServer();
  })
  .client(fetchSessionClient);

async function authRequest(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${AUTH_BASE}${path}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({})) as { message?: string | undefined; error?: string | undefined; code?: string };
    const err = new Error(data.message ?? data.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = data.code ?? (data.error ?? undefined!);
    throw err;
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export function signInEmail(input: { email: string; password: string }): Promise<SignInResponse> {
  return authRequest("/sign-in/email", input) as Promise<SignInResponse>;
}

export function signOut(): Promise<void> {
  return authRequest("/sign-out", {}) as Promise<void>;
}

// Verification-token password set for admin-issued set-password links
// (/set-password?token=) only: the server resolves the token to the existing
// account (identifier `reset-password:<token>`,
// server/services/password-links.service.ts) and runs better-auth's native
// /reset-password, which sets the password and revokes existing sessions
// (`revokeSessionsOnPasswordReset`) — including any session current on this
// device, so a signed-in caller is signed out by the reset. It returns
// `{ status: true }` and seeds NO session cookie — the user must sign in
// afterwards. Workspace invitation links (/invite?token=) live in a different
// table and use acceptInvite below — the two token kinds are not
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
