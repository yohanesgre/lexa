import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { AuthIdentity, AuthIdentityShape } from "./auth";
import { constantTimeTokenEqual, resolveApiKeyIdentity } from "./auth-key";
import { MAX_API_BODY } from "./limits";

// API-level middleware wrapped around the whole HttpApi router. Applied at
// build time; runs before route matching (incl. 404s) and before
// decodePath/decodePayload/decodeHeaders. Checks in order: content-length
// pre-check → auth (daemon-token/setup/health exempt) → rate limit →
// security headers. `db` is the shared Sqlite connection (http.ts's
// Layer.succeed(Sqlite, db)) — never open per-request databases.
export function createApiMiddleware(db: Database) {
  return HttpApiBuilder.middleware((httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest;
      const path = request.url.split(/[?#]/)[0];

      const declared = Number(request.headers["content-length"] ?? 0);
      if (declared > MAX_API_BODY) {
        console.warn(`[API] body too large path=${path} declared=${request.headers["content-length"] ?? "unknown"} bytes`);
        return HttpServerResponse.unsafeJson(
          { error: { code: "BODY_TOO_LARGE", message: "Request body too large" } },
          { status: 413 }
        );
      }

      const isSetup = path.startsWith("/api/setup");
      const isHealth = path === "/api/health";
      // Forge daemon endpoints accept the daemon token (LXK_FORGE_DAEMON_TOKEN)
      // in place of the API key — the daemon may hold its own credential.
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
