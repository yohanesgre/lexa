import { Effect } from "effect";
import { auth } from "../auth";

// Session helper (better-auth#10132): an uncaught getSession throw crashes
// SSR, so every call is try/catch'd — session-less callers get null, never
// an error.
export class SessionService extends Effect.Service<SessionService>()("Lexa/SessionService", {
  effect: Effect.gen(function* () {
    return {
      userFrom: (headers: Headers) =>
        Effect.tryPromise(() => auth.api.getSession({ headers })).pipe(
          Effect.map((session) => session?.user ?? null),
          Effect.catchAll(() => Effect.succeed(null)),
        ),
    };
  }),
}) {}
