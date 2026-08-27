import { HttpApiBuilder, HttpApiEndpoint, HttpApiGroup } from "@effect/platform";
import { Effect, Schema, Data } from "effect";
import type { LexaApi } from "./http";
import { respond } from "./http-helpers";
import { auth } from "../auth";
import type { SessionInfo } from "../../shared/types";

export class SessionNotFound extends Data.TaggedError("SessionNotFound")<{}> {}

const SessionInfoSchema = Schema.Struct({
  id: Schema.String,
  ipAddress: Schema.NullOr(Schema.String),
  userAgent: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
  createdAt: Schema.String,
});

const SessionIdPath = Schema.Struct({ sessionId: Schema.String });

const toSessionInfo = (s: { id: string; ipAddress?: string | null; userAgent?: string | null; expiresAt: string | Date; createdAt: string | Date }): SessionInfo => ({
  id: s.id,
  ipAddress: s.ipAddress ?? null,
  userAgent: s.userAgent ?? null,
  expiresAt: new Date(s.expiresAt).toISOString(),
  createdAt: new Date(s.createdAt).toISOString(),
});

// Self-service sessions: list + revoke own sessions only. Revoking a foreign
// session id → 404 (no existence oracle). The native revokeSession endpoint
// takes the session TOKEN (not id) and silently no-ops on other users'
// sessions — so resolve id → token against the caller's own list first.
export const sessionsGroup = HttpApiGroup.make("sessions")
  .add(HttpApiEndpoint.get("listSessions", "/sessions").addSuccess(Schema.Struct({ data: Schema.Array(SessionInfoSchema) })))
  .add(HttpApiEndpoint.post("revokeSession", "/sessions/:sessionId/revoke").setPath(SessionIdPath).addSuccess(Schema.Void, { status: 204 }));

export const createSessionsLive = (api: typeof LexaApi) =>
  HttpApiBuilder.group(api, "sessions", (handlers) =>
    handlers
      .handle("listSessions", (req) =>
        respond(Effect.gen(function* () {
          const headers = new Headers(req.request.headers);
          const sessions = yield* Effect.tryPromise(() => auth.api.listSessions({ headers })).pipe(
            Effect.mapError(() => new Error("listSessions failed"))
          );
          const own = ((sessions ?? []) as Parameters<typeof toSessionInfo>[0][])
            .map(toSessionInfo)
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
          return { data: own };
        }))
      )
      .handle("revokeSession", (req) =>
        respond(Effect.gen(function* () {
          const headers = new Headers(req.request.headers);
          const sessions = yield* Effect.tryPromise(() => auth.api.listSessions({ headers })).pipe(
            Effect.mapError(() => new Error("listSessions failed"))
          );
          const target = (sessions ?? []).find((s) => s.id === req.path.sessionId);
          if (!target) {
            return yield* Effect.fail(new SessionNotFound());
          }
          yield* Effect.tryPromise(() => auth.api.revokeSession({ body: { token: target.token }, headers })).pipe(
            Effect.mapError(() => new Error("revokeSession failed"))
          );
        }))
      )
  );
