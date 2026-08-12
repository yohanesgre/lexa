import { HttpServerResponse } from "@effect/platform";
import { Cause, Effect } from "effect";
import { errorResponse, errorToStatus } from "./errors";

// Shared handler wrapper: map tagged errors to the envelope + status, log
// the raw cause server-side, and turn defects into 500s. Extracted from
// http.ts so the teams/workspace/sessions groups live in their own files.
export const respond = <A, E, R>(eff: Effect.Effect<A, E, R>): Effect.Effect<A | HttpServerResponse.HttpServerResponse, never, R> =>
  eff.pipe(
    Effect.catchAllCause((cause) => {
      const failure = Cause.failureOption(cause);
      if (failure._tag === "Some") {
        const err = failure.value as { _tag: string } & Record<string, unknown>;
        const resp = errorResponse(err);
        const status = errorToStatus(err);
        // Raw message/cause stay server-side (client response is scrubbed by
        // errorResponse/errorDetails). Embedded in the message — the HttpApi
        // handler path drops annotateLogs annotations.
        const rawMessage = err.message !== undefined ? String(err.message) : "";
        const rawCause = err.cause instanceof Error ? err.cause.message : err.cause !== undefined ? String(err.cause) : "";
        const raw = rawCause ? `${rawMessage} (cause: ${rawCause})` : rawMessage;
        return Effect.logError(`[HTTP] ${status} ${resp.error.code}: ${resp.error.message} [raw: ${raw}]`).pipe(
          Effect.annotateLogs({ code: resp.error.code, status, ...resp.error.details, rawMessage, rawCause }),
          Effect.as(HttpServerResponse.unsafeJson(resp, { status })),
        );
      }
      for (const d of Cause.defects(cause)) {
        console.error("[API] Defect:", d instanceof Error ? d.message : String(d), d instanceof Error ? d.stack : undefined);
      }
      return Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: { code: "INTERNAL", message: "Internal error" } },
          { status: 500 }
        )
      );
    })
  );
