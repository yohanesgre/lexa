import { HttpApiBuilder, HttpServerResponse } from "@effect/platform";
import { HttpServerRequest } from "@effect/platform/HttpServerRequest";
import { Effect } from "effect";
import { Database } from "bun:sqlite";
import { MAX_API_BODY } from "./limits";

// API-level middleware wrapped around the whole HttpApi router. Applied at
// build time; runs before route matching (incl. 404s) and before
// decodePath/decodePayload/decodeHeaders. Entry.ts's per-request checks
// migrate here stepwise: content-length pre-check → auth → rate limit →
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

      return yield* httpApp;
    })
  );
}
