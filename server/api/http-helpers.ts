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
        const err = failure.value as { _tag: string; stack?: string; cause?: unknown } & Record<string, unknown>;
        const resp = errorResponse(err);
        const status = errorToStatus(err);
        const isTransientChat404 = err._tag === "HeraldThreadNotFound" && (err as { documentType?: unknown }).documentType === "chat";
        if (isTransientChat404) {
          const chatId = String((err as { documentId?: unknown }).documentId ?? resp.error.details["documentId"] ?? "");
          try {
            const line = JSON.stringify({
              level: "INFO",
              service: "http",
              message: `[HTTP] ${status} ${resp.error.code}: ${resp.error.message}`,
              meta: { code: resp.error.code, status, chatId },
              timestamp: new Date().toISOString(),
            });
            process.stderr.write(line + "\n");
          } catch {}
          return Effect.logInfo(`[HTTP] ${status} ${resp.error.code}: ${resp.error.message}`).pipe(
            Effect.annotateLogs({ code: resp.error.code, status, chatId }),
            Effect.as(HttpServerResponse.unsafeJson(resp, { status })),
          );
        }
        const rawMessage = err.message !== undefined ? String(err.message) : "";
        const rawCause = err.cause instanceof Error ? `${(err.cause as Error).name}: ${(err.cause as Error).message}` : err.cause !== undefined && err.cause !== null ? (() => { try { return typeof err.cause === "string" ? err.cause as string : JSON.stringify(err.cause as unknown); } catch { return String(err.cause); } })() : "";
        const raw = rawCause ? `${rawMessage} (cause: ${rawCause})` : rawMessage;
        const stack = typeof err.stack === "string" ? err.stack.slice(0, 2000) : null;
        const causeChain = (() => {
          try {
            const chain: string[] = [];
            let cur: unknown = err;
            for (let i = 0; i < 5; i++) {
              const c = (cur as Record<string, unknown>)?.cause;
              if (c === undefined || c === null) break;
              chain.push(c instanceof Error ? `${(c as Error).name}: ${(c as Error).message}` : typeof c === "string" ? String(c).slice(0, 400) : JSON.stringify(c).slice(0, 400));
              cur = c;
              if (typeof cur !== "object" || cur === null) break;
            }
            return chain.length > 0 ? chain.join(" -> ").slice(0, 800) : null;
          } catch { return null; }
        })();
        const rawEvent = (() => {
          try {
            const v = (err as Record<string, unknown>).rawEvent ?? (err as Record<string, unknown>).cause ?? null;
            if (v === null || v === undefined) return null;
            return (typeof v === "string" ? v : JSON.stringify(v)).slice(0, 800);
          } catch { return null; }
        })();
        const fiberPretty = (() => { try { return Cause.pretty(cause).slice(0, 2000); } catch { return String(cause).slice(0, 2000); } })();
        try {
          const line = JSON.stringify({
            level: "ERROR",
            service: "http",
            message: `[HTTP] ${status} ${resp.error.code}: ${resp.error.message} [raw: ${raw.slice(0, 800)}]`,
            meta: { code: resp.error.code, status, ...resp.error.details, rawMessage: rawMessage.slice(0, 800), rawCause: rawCause.slice(0, 800), rawEvent, stack, causeChain, fiberCause: fiberPretty },
            timestamp: new Date().toISOString(),
          });
          process.stderr.write(line + "\n");
        } catch {}
        return Effect.logError(`[HTTP] ${status} ${resp.error.code}: ${resp.error.message} [raw: ${raw}]`).pipe(
          Effect.annotateLogs({ code: resp.error.code, status, ...resp.error.details, rawMessage, rawCause, stack: stack ?? undefined, causeChain: causeChain ?? undefined, fiberCause: fiberPretty.slice(0, 800) }),
          Effect.as(HttpServerResponse.unsafeJson(resp, { status })),
        );
      }
      for (const d of Cause.defects(cause)) {
        console.error("[API] Defect:", d instanceof Error ? d.message : String(d), d instanceof Error ? d.stack : undefined);
        try {
          const line = JSON.stringify({ level: "ERROR", service: "http", message: `defect: ${String(d instanceof Error ? d.message : d).slice(0, 500)}`, meta: { stack: d instanceof Error ? d.stack?.slice(0, 2000) ?? null : null, defect: String(d).slice(0, 800), fiberCause: (() => { try { return Cause.pretty(cause).slice(0, 2000); } catch { return String(cause).slice(0, 2000); } })() }, timestamp: new Date().toISOString() });
          process.stderr.write(line + "\n");
        } catch {}
      }
      return Effect.succeed(
        HttpServerResponse.unsafeJson(
          { error: { code: "INTERNAL", message: "Internal error" } },
          { status: 500 }
        )
      );
    })
  );
