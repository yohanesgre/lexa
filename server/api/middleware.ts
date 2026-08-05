import { HttpApiBuilder } from "@effect/platform";
import { Database } from "bun:sqlite";

// API-level middleware wrapped around the whole HttpApi router. Applied at
// build time; runs before route matching (incl. 404s) and before
// decodePath/decodePayload/decodeHeaders. Entry.ts's per-request checks
// migrate here stepwise: content-length pre-check → auth → rate limit →
// security headers. `db` is the shared Sqlite connection (http.ts's
// Layer.succeed(Sqlite, db)) — never open per-request databases.
export function createApiMiddleware(db: Database) {
  return HttpApiBuilder.middleware((httpApp) => httpApp);
}
