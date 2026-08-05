import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { AuthIdentity, AuthIdentityShape } from "./auth";
import { constantTimeTokenEqual, resolveApiKeyIdentity } from "./auth-key";
import { MAX_API_BODY, X_LEXA_REMOTE_IP } from "./limits";
import { apiRateLimiter, isPrivateIp } from "./rate-limit";

// API-level middleware wrapped around the whole HttpApi router. Applied at
// build time; runs before route matching (incl. 404s) and before
// decodePath/decodePayload/decodeHeaders. Checks in order: rate limit →
// content-length pre-check → auth (daemon-token/setup/health exempt) →
// security headers. `db` is the shared Sqlite connection (http.ts's
// Layer.succeed(Sqlite, db)) — never open per-request databases.
export function createApiMiddleware(db: Database) {
  return HttpApiBuilder.middleware((httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const path = request.url.split(/[?#]/)[0];

      const isSetup = path.startsWith("/api/setup");
      const isHealth = path === "/api/health";

      // Rate limit before auth: a blocked IP stays blocked regardless of key.
      // IP is resolved in entry (socket only visible there) and stamped on the
      // reconstructed Request — any inbound x-lexa-remote-ip is deleted first.
      const stampedIp = request.headers[X_LEXA_REMOTE_IP] ?? "";
      const cfIp = request.headers["cf-connecting-ip"];
      const ip = stampedIp && isPrivateIp(stampedIp) && cfIp ? cfIp : (stampedIp || cfIp || "unknown");
      if (!isSetup && !isHealth && !apiRateLimiter.check(ip)) {
        const retryAfter = Math.ceil(apiRateLimiter.retryAfterMs(ip) / 1000);
        console.warn(`[API] rate limited ip=${ip} retryAfter=${retryAfter}s`);
        return HttpServerResponse.unsafeJson(
          { error: { code: "RATE_LIMITED", message: "Rate limit exceeded" } },
          { status: 429 }
        ).pipe(HttpServerResponse.setHeader("Retry-After", String(retryAfter)));
      }

      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_API_BODY) {
        console.warn(`[API] body too large path=${path} declared=${request.headers["content-length"] ?? "unknown"} bytes`);
        return HttpServerResponse.unsafeJson(
          { error: { code: "BODY_TOO_LARGE", message: "Request body too large" } },
          { status: 413 }
        );
      }

      const isForgeDaemon = path.startsWith("/api/forge/daemon/") || path === "/api/forge/runtimes/register";
      const daemonTokenOk = isForgeDaemon && process.env.LXK_FORGE_DAEMON_TOKEN
        ? constantTimeTokenEqual(request.headers["x-forge-token"] ?? "", process.env.LXK_FORGE_DAEMON_TOKEN)
        : false;
      let identity: AuthIdentityShape;
      if (!isHealth && !isSetup && !daemonTokenOk) {
        const authHeader = request.headers["authorization"] ?? "";
        const resolved = resolveApiKeyIdentity(authHeader, db);
        if (!resolved) {
          const reason = authHeader.startsWith("Bearer ") ? "unknown key" : "missing or malformed key";
          console.warn(`[Auth] denied path=${path} reason=${reason}`);
          return HttpServerResponse.unsafeJson(
            { error: { code: "UNAUTHORIZED", message: "Invalid or missing API key" } },
            { status: 401 }
          );
        }
        if (resolved.userId !== null && resolved.role !== "admin") {
          console.warn(`[Auth] denied path=${path} reason=member key`);
          return HttpServerResponse.unsafeJson(
            { error: { code: "FORBIDDEN", message: "Member API keys are not supported on the REST API yet" } },
            { status: 403 }
          );
        }
        identity = { userId: resolved.userId, role: resolved.role };
      } else {
        identity = { userId: null, role: "admin" };
      }

      return yield* httpApp.pipe(Effect.provideService(AuthIdentity, identity));
    })
  );
}
