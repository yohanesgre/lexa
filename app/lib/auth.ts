import { createIsomorphicFn } from "@tanstack/react-start";
import type { LexaUser } from "../../shared/types";

// Better Auth session surface (BE pins better-auth 1.6.27; the handler is
// mounted at /api/auth/*). The FE talks to it over plain fetch — the cookie
// (httpOnly, secure, 7d sliding) is managed by the browser, no client SDK.

export interface SessionUser extends LexaUser {}

export interface AuthSession {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface SessionResponse {
  session: AuthSession | null;
  user: SessionUser | null;
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
    const data = await res.json().catch(() => ({})) as { message?: string; error?: string; code?: string };
    const err = new Error(data.message ?? data.error ?? `HTTP ${res.status}`) as Error & { code?: string };
    err.code = data.code ?? (data.error ?? undefined);
    throw err;
  }
  if (res.status === 204) return undefined;
  return res.json();
}

export function signInEmail(input: { email: string; password: string }): Promise<SessionResponse> {
  return authRequest("/sign-in/email", input) as Promise<SessionResponse>;
}

export function signOut(): Promise<void> {
  return authRequest("/sign-out", {}) as Promise<void>;
}

// Verification-token password set — the shared accept path for both
// admin-issued set-password links (/set-password?token=) and workspace
// invitation links (/invite?token=): the server resolves the token to the
// account (invite accept mints the member account) and establishes the
// session cookie. The token row is minted with the native
// `reset-password:<token>` identifier (server/services/password-links.service.ts),
// so consumption goes through better-auth's native /reset-password endpoint.
export function setPassword(input: { newPassword: string; token: string }): Promise<SessionResponse> {
  return authRequest("/reset-password", input) as Promise<SessionResponse>;
}

export function changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
  return authRequest("/change-password", input) as Promise<void>;
}
