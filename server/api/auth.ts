import { Context, Effect } from "effect";

export class AuthUser extends Context.Tag("Lexa/AuthUser")<AuthUser, { email: string }>() {}

export function extractAuth(headers: Headers): Effect.Effect<{ email: string }, never> {
  const email = headers.get("Cf-Access-Authenticated-User-Email");
  if (email) return Effect.succeed({ email });
  return Effect.succeed({ email: "anonymous" });
}
