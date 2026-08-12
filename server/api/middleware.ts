import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Cause, Effect } from "effect";
import { Database } from "bun:sqlite";
import { AuthIdentity, AuthIdentityShape } from "./auth";
import { constantTimeTokenEqual, resolveApiKeyIdentity } from "./auth-key";
import { MAX_API_BODY, X_LEXA_REMOTE_IP } from "./limits";
import { apiRateLimiter, isPrivateIp, isRateLimitExemptPath } from "./rate-limit";
import { auth } from "../auth";

// API-level middleware wrapped around the whole HttpApi router. Applied at
// build time; runs before route matching (incl. 404s) and before
// decodePath/decodePayload/decodeHeaders. Checks in order: rate limit →
// content-length pre-check → auth (session cookie OR Bearer key;
// daemon-token/setup/health exempt) → security headers on every /api
// response. `db` is the shared Sqlite connection (http.ts's
// Layer.succeed(Sqlite, db)) — never open per-request databases.
const withSecurityHeaders = (resp: HttpServerResponse.HttpServerResponse) =>
  HttpServerResponse.setHeaders(resp, { "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" });

// Session caller → identity. The session user's role maps superadmin→admin
// so the legacy requireAdmin gates stay correct until the authorization
// service replaces them (R14). Every getSession is try/catch'd (R1 — an
// uncaught throw would crash the request).
const sessionIdentity = (headers: Headers): Effect.Effect<AuthIdentityShape | null, never> =>
  Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
    Effect.map((session) => {
      const user = session?.user;
      if (!user) return null;
      return {
        keyId: "",
        keyName: user.name,
        userId: user.id,
        userName: user.name,
        role: user.role === "superadmin" ? ("admin" as const) : ("member" as const),
      };
    }),
    Effect.catchAll(() => Effect.succeed(null))
  );

export function createApiMiddleware(db: Database, dbPath: string) {
  return HttpApiBuilder.middleware((httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const path = request.url.split(/[?#]/)[0];

      const isSetup = path.startsWith("/api/setup");
      const isHealth = path === "/api/health";
      // Forge daemon endpoints accept the daemon token (LXK_FORGE_DAEMON_TOKEN)
      // in place of the API key — the daemon may hold its own credential.
      // /api/forge/sessions joins them: the daemon PUTs the pre-spawn mapping
      // and DELETEs it on cancel/timeout with x-forge-token; the browser
      // GET/reset keep using the Bearer key.
      const isForgeDaemon = path.startsWith("/api/forge/daemon/") || path === "/api/forge/runtimes/register" || path === "/api/forge/sessions";

      // Rate limit before auth: a blocked IP stays blocked regardless of key.
      // The key/token-gated forge machine surfaces are exempt (isRateLimitExemptPath:
      // daemon log POSTs, runtime registration, the listener's 3s heartbeat — a
      // chatty agent's traffic must not share the IP bucket); setup and health are
      // rate-limited again. IP is resolved in entry (socket only visible there) and
      // stamped on the reconstructed Request — any inbound x-lexa-remote-ip is
      // deleted first.
      const stampedIp = request.headers[X_LEXA_REMOTE_IP] ?? "";
      const cfIp = request.headers["cf-connecting-ip"];
      const ip = stampedIp && isPrivateIp(stampedIp) && cfIp ? cfIp : (stampedIp || cfIp || "unknown");
      if (!isRateLimitExemptPath(path) && !apiRateLimiter.check(ip)) {
        const retryAfter = Math.ceil(apiRateLimiter.retryAfterMs(ip) / 1000);
        console.warn(`[API] rate limited ip=${ip} retryAfter=${retryAfter}s`);
        return withSecurityHeaders(
          HttpServerResponse.unsafeJson(
            { error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } },
            { status: 429 }
          ).pipe(HttpServerResponse.setHeader("Retry-After", String(retryAfter)))
        );
      }

      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_API_BODY) {
        console.warn(`[API] body too large path=${path} declared=${request.headers["content-length"] ?? "unknown"} bytes`);
        return withSecurityHeaders(
          HttpServerResponse.unsafeJson(
            { error: { code: "BODY_TOO_LARGE", message: "Request body too large" } },
            { status: 413 }
          )
        );
      }

      const daemonTokenOk = isForgeDaemon && process.env.LXK_FORGE_DAEMON_TOKEN
        ? constantTimeTokenEqual(request.headers["x-forge-token"] ?? "", process.env.LXK_FORGE_DAEMON_TOKEN)
        : false;
      let identity: AuthIdentityShape;
      if (!isHealth && !isSetup && !daemonTokenOk) {
        // Dual-channel (R4): session cookie first (browsers), Bearer key
        // second (machines). The x-lxk-user header is removed — never read.
        const session = yield* sessionIdentity(new Headers(request.headers));
        if (session) {
          identity = session;
        } else {
          const authHeader = request.headers["authorization"] ?? "";
          const resolved = resolveApiKeyIdentity(authHeader, new Headers(request.headers), db, dbPath);
          if (!resolved) {
            const reason = authHeader.startsWith("Bearer ") ? "unknown key" : "missing or malformed key";
            console.warn(`[Auth] denied path=${path} reason=${reason}`);
            return withSecurityHeaders(
              HttpServerResponse.unsafeJson(
                { error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } },
                { status: 401 }
              )
            );
          }
          if (resolved.userId !== null && resolved.role === "member") {
            console.warn(`[Auth] denied path=${path} reason=member key`);
            return withSecurityHeaders(
              HttpServerResponse.unsafeJson(
                { error: { code: "FORBIDDEN", message: "Member API keys are not supported on the REST API yet" } },
                { status: 403 }
              )
            );
          }
          identity = resolved;
        }
      } else {
        identity = { keyId: "", keyName: "", userId: null, userName: null, role: "admin" };
      }

      const response = yield* httpApp.pipe(
        Effect.provideService(AuthIdentity, identity),
        // Router misses fail with RouteNotFound AFTER this middleware wraps the
        // app — catch it here so the 404 also carries the security headers
        // (same empty-body shape the platform's error encoder produces).
        Effect.catchAllCause((cause) => {
          const failure = Cause.failureOption(cause);
          if (failure._tag === "Some" && (failure.value as { _tag?: string })._tag === "RouteNotFound") {
            return Effect.succeed(
              withSecurityHeaders(HttpServerResponse.empty().pipe(HttpServerResponse.setStatus(404)))
            );
          }
          return Effect.failCause(cause);
        })
      );
      return withSecurityHeaders(response);
    })
  );
}
