// Test-only shim: vitest workers run under node, which cannot resolve
// `cloudflare:workers` (a workerd builtin). `server/workers-entry.ts` imports
// the assistant DO class, which pulls in `agents` / `@cloudflare/ai-chat`, and
// those packages `import ... from "cloudflare:workers"`. vitest.config.ts
// aliases the specifier to this file (same pattern as the bun:sqlite shim) so
// the node-side suite can load the module graph. Production runs under workerd,
// where the real module exists; this file is never imported there.
//
// Surface = exactly the named exports the packages import (grep
// node_modules/agents for `from "cloudflare:workers"`): DurableObject, RpcTarget,
// WorkflowEntrypoint, `exports`, plus `tracing` read off a namespace import.

export class DurableObject<Env = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  protected ctx: unknown;
  protected env: Env;
  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

// `cloudflare:workers`'s `exports` is the Worker's module.exports registry
// (live object). Nothing here is a worker entry, so an empty registry is exact
// for node tests.
export const exports: Record<string, unknown> = {};

// `cloudflareWorkers.tracing` is probed with optional chaining; undefined is a
// supported "runtime without native tracing" answer.
export const tracing: { startActiveSpan?: unknown } | undefined = undefined;

// `agents` imports `EmailMessage` from `cloudflare:email` (referenced lazily
// inside a reply method, never on the paths the node suite exercises).
// vitest.config.ts aliases `cloudflare:email` to this same shim.
export class EmailMessage {
  constructor(
    public readonly from: string,
    public readonly to: string,
    public readonly raw: string
  ) {}
}
