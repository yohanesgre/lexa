import type { SessionResponse } from "./auth";

const AUTH_BASE = "/api/auth";

// Server-only session resolution: reads the incoming request's cookies from
// the request context (SSR) and forwards them to the Better Auth handler.
// Without a request context (tests) it degrades to a same-origin fetch. Any
// failure returns "no session" — the guard redirects to /login and the client
// resolves the real state.
export async function fetchSessionServer(): Promise<SessionResponse> {
  try {
    const serverPkg = "@tanstack/react-start-server";
    let url = `${AUTH_BASE}/get-session`;
    const headers: Record<string, string> = {};
    try {
      const { getRequest } = await import(serverPkg);
      const request = getRequest();
      const cookie = request?.headers.get("cookie");
      if (cookie) headers.cookie = cookie;
      const origin = typeof process !== "undefined" ? (process.env.LXK_PUBLIC_URL ?? "http://localhost:3000") : "http://localhost:3000";
      url = `${origin}${AUTH_BASE}/get-session`;
    } catch {
      // no request context — same-origin fetch below
    }
    const res = await fetch(url, { credentials: "include", headers });
    if (!res.ok) return { session: null, user: null };
    return (await res.json()) as SessionResponse;
  } catch {
    return { session: null, user: null };
  }
}
