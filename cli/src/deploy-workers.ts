// lexa-cli deploy workers — Cloudflare Workers + D1 + R2 + KV + cron stack
// provisioning. Parallel to `deploy.ts` (the Bun+Docker path). Phase 10
// wires the runtime pick; the full Cloudflare API orchestration is a
// follow-up plan.
//
// Usage:
//   lexa-cli deploy <domain> workers [staging|prod] [flags]
//
// Provisioning order (per ADR-0002):
//   1. POST /accounts/{id}/d1/database                    → D1 database (lexa-<flavor>)
//   2. POST /accounts/{id}/r2/buckets                     → R2 bucket  (lexa-blobs-<flavor>)
//   3. POST /accounts/{id}/storage/kv/namespaces          → KV namespace
//   4. wrangler deploy                                    → Worker (the prebuilt bundle from .github/workflows/publish.yml)
//   5. POST /zones/{id}/workers/routes                    → Worker route at <subdomain>.<domain>/*
//   6. wrangler secret put LXK_API_KEY (and the rest)     → interactive
//
// Teardown (lexa-cli undeploy <domain> workers):
//   1. DELETE Worker route
//   2. wrangler delete
//   3. --purge-data only: DELETE D1, R2 bucket, KV namespace
//
// The module below is the dispatch-point wiring; the Cloudflare API
// calls land in a follow-up. Today `cmdDeployWorkers` reports the
// provisioning plan and returns success — operators use
// `wrangler deploy` + the Cloudflare dashboard until Phase 10+ wires
// the full API calls.

import { Effect } from "effect";

export function cmdDeployWorkers(
  flags: Record<string, string | boolean>,
  positionals: string[]
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const domain = positionals[0]!;
    if (!domain) {
      console.error("  ERROR: missing <domain> positional");
      console.error("  Usage: lexa-cli deploy <domain> workers [staging|prod] [flags]");
      process.exit(1);
    }
    const flavor = positionals[1]! === "staging" ? "staging" : "prod";
    const subdomain = flavor === "staging" ? "lexa-preview" : "lexa";

    console.log(`==> Workers flavor: <${subdomain}.${domain}>`);
    console.log("    Provisioning plan (per ADR-0002):");
    console.log("      1. POST /accounts/{id}/d1/database");
    console.log(`         → D1 database name: lexa-${flavor}`);
    console.log("      2. POST /accounts/{id}/r2/buckets");
    console.log(`         → R2 bucket name:    lexa-blobs-${flavor}`);
    console.log("      3. POST /accounts/{id}/storage/kv/namespaces");
    console.log(`         → KV namespace for   ${flavor}`);
    console.log("      4. wrangler deploy (prebuilt bundle from .github/workflows/publish.yml)");
    console.log("      5. POST /zones/{id}/workers/routes");
    console.log(`         → route: ${subdomain}.${domain}/*`);
    console.log("      6. wrangler secret put LXK_API_KEY (and the rest)");
    console.log("");
    console.log("  Phase 10 follow-up wires the actual Cloudflare API calls.");
    console.log("  For now, run wrangler deploy + the dashboard manually.");
    void flags;
  });
}

export function cmdUndeployWorkers(
  flags: Record<string, string | boolean>,
  positionals: string[]
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const domain = positionals[0]!;
    if (!domain) {
      console.error("  ERROR: missing <domain> positional");
      console.error("  Usage: lexa-cli undeploy <domain> workers [staging|prod]");
      process.exit(1);
    }
    const purgeData = flags["purge-data"] === true;
    console.log(`==> Workers undeploy: <${domain}>`);
    console.log("    Teardown plan:");
    console.log("      1. DELETE Worker route");
    console.log("      2. wrangler delete");
    if (purgeData) {
      console.log("      3. --purge-data: DELETE D1, R2 bucket, KV namespace (irreversible)");
    } else {
      console.log("      3. (data preserved — pass --purge-data to delete D1/R2/KV)");
    }
    console.log("");
    console.log("  Phase 10 follow-up wires the actual Cloudflare API calls.");
    void flags;
  });
}
