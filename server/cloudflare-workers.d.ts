// `cloudflare:workers` is a workerd builtin with no module on disk. TypeScript
// cannot resolve a direct import of it: the declaration shipped in
// `@cloudflare/workers-types` sits in a d.ts that is itself a module, so its
// `declare module "cloudflare:workers"` is an augmentation, not a definition —
// it only resolved while `agents` / `@cloudflare/ai-chat` (removed in ADR-0005
// W6) pulled it in transitively.
//
// This is the minimal definition the supervisor Durable Object needs, and only
// what it uses: `ctx.waitUntil` (the run outliving the client request) and
// `env`. Keep it in step with `cloudflare-workers.shim.ts`, which serves the
// same module for the vitest runtime. Deliberately NOT a module file — a
// top-level import/export would turn this back into an augmentation.
declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: { waitUntil(promise: Promise<unknown>): void };
    protected readonly env: Env;
    protected fetch?(request: Request): Promise<Response>;
  }
}
