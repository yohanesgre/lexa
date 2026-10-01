import { Context } from "effect";

export interface AuthSessionSummary {
  id: string;
  token: string;
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
  expiresAt: string | Date;
  createdAt: string | Date;
}

// Per-runtime better-auth surface for handlers. The Bun host wires the
// process-wide singleton; the Workers factory wires its per-request
// createAuth(env) instance (D1 adapter). Handlers MUST yield this tag
// instead of importing server/auth.ts — that module's singleton cannot run
// on workerd (no process.env, and bun:sqlite is a throwing shim).
export interface ApiAuthHooksShape {
  createUser(input: { email: string; password: string; name: string }): Promise<unknown>;
  listSessions(headers: Headers): Promise<readonly AuthSessionSummary[] | null | undefined>;
  revokeSession(input: { token: string; headers: Headers }): Promise<unknown>;
}

export class ApiAuthHooks extends Context.Tag("Lexa/ApiAuthHooks")<ApiAuthHooks, ApiAuthHooksShape>() {}
