import type { SessionResponse } from "./auth";

const AUTH_BASE = "/api/auth";

// Server-only session resolution: reads the incoming request's cookies from
// the request context (SSR) and forwards them to the Better Auth handler.
// Without a request context (tests) it degrades to a same-origin fetch. Any
// failure returns "no session" — the guard redirects to /login and the client
// resolves the real state.
export async function fetchSessionServer(): Promise<SessionResponse> {
  try {
    // The literal specifier form trips vite's client dep optimizer (it
    // statically scans literal imports and tries to pre-bundle
    // @tanstack/react-start-server, which references the unresolved
    // #tanstack-router-entry virtual). The variable-held form is opaque to the
    // scanner, so this server-only module stays out of the client graph.
    const serverPkg = "@tanstack/react-start-server";
    let url = `${AUTH_BASE}/get-session`;
    const headers: Record<string, string> = {};
    try {
      const { getRequest } = await import(/* @vite-ignore */ serverPkg);
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
    // Unauthenticated get-session returns HTTP 200 with body null — normalize
    // it so SSR callers can read `.session` without a crash.
    const data = (await res.json()) as SessionResponse | null;
    return data ?? { session: null, user: null };
  } catch {
    return { session: null, user: null };
  }
}
