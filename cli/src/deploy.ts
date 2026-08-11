// lexa-cli deploy — Docker Compose + cloudflared tunnel + Cloudflare Access
// provisioning. TypeScript port of the former scripts/setup.sh. Deploy
// credentials persist in ~/.lexa/config.json (prod) or ~/.lexa-staging/config.json
// under the `deploy` key, so deploy works without a saved login (url/apiKey).
import { Effect, Data } from "effect";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { CliConfigService, lexaDirFor, type LexaFlavor } from "./config";
import { COMPOSE_FILES } from "./packed-compose";

const CF_API = "https://api.cloudflare.com/client/v4";

interface Flavor {
  subdomain: string;
  tunnelName: string;
  composeName: string;
  composeFiles: string;
  envFile: string;
}

export const FLAVORS: Record<string, Flavor> = {
  staging: { subdomain: "lexa-preview", tunnelName: "lexa-staging", composeName: "lexa-staging", composeFiles: "-f docker-compose.yml -f docker-compose.staging.yml", envFile: ".env.staging" },
  prod: { subdomain: "lexa", tunnelName: "lexa-prod", composeName: "lexa-prod", composeFiles: "-f docker-compose.yml -f docker-compose.prod.yml", envFile: ".env.prod" },
};

function usage(): never {
  console.error("Usage: lexa-cli deploy <domain> [staging|prod] [flags]");
  console.error("  staging — remote, lexa-preview.<domain>, .env.staging");
  console.error("  prod    — remote, lexa.<domain>, .env.prod");
  console.error("");
  console.error("Flags (all optional — prompts fill what's missing on a TTY):");
  console.error("  --deploy-dir <path>       compose/env working dir (default: ~/.lexa/deploy; staging: ~/.lexa-staging/deploy)");
  console.error("  --image <tag>             image tag to deploy (default: latest; staging flavor: staging)");
  console.error("  --clean                   recreate from scratch — removes the data volume (DB wiped)");
  console.error("  --cf-token <token>        Cloudflare API token (env: CF_API_TOKEN)");
  console.error("  --google-client-id <id>   Google OAuth client ID");
  console.error("  --google-client-secret <s> Google OAuth client secret");
  console.error("  --team-domain <domain>    CF Access team domain (env: CF_TEAM_DOMAIN)");
  console.error("  --email-domain <domain>   allowed email domain for the Access policy");
  console.error("  --admin-email <email>     admin email (reuses LXK_ADMIN_EMAILS from the env file)");
  console.error("  --api-key <key>           lxk_ API key (reuses LXK_API_KEY from the env file)");
  console.error("");
  console.error("Usage: lexa-cli undeploy <domain> [staging|prod] [flags]");
  console.error("  staging — remote, lexa-preview.<domain>, .env.staging");
  console.error("  prod    — remote, lexa.<domain>, .env.prod");
  console.error("");
  console.error("Reverses deploy: docker compose down -v (DB wiped), Cloudflare resources");
  console.error("(DNS, tunnel, Access app + policies, Google IdP), and local state (deploy dir + creds).");
  console.error("Flags:");
  console.error("  --cf-token <token>        Cloudflare API token (env: CF_API_TOKEN)");
  console.error("  --deploy-dir <path>       compose/env working dir (default: ~/.lexa/deploy; staging: ~/.lexa-staging/deploy)");
  console.error("  --yes                     confirm teardown without a prompt (non-TTY only)");
  process.exit(1);
}

// Typed failures. `reason` is the exact stderr line the imperative version
// printed, so a caller that logs `error.message` reproduces the output.
export class DeployError extends Data.TaggedError("DeployError")<{
  reason: string;
}> {
  get message(): string {
    return this.reason;
  }
}

export class CfApiError extends Data.TaggedError("CfApiError")<{
  status: number;
  cfMessage?: string;
  code?: number;
}> {
  get message(): string {
    return `Cloudflare API error: ${this.cfMessage ?? this.status}${this.code !== undefined ? ` (${this.code})` : ""}`;
  }
}

// Cloudflare JSON envelope; `result` stays unknown — cast at each call site.
interface CfEnvelope {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  result: unknown;
}

function cfFetch(token: string, path: string, init?: RequestInit): Effect.Effect<unknown, CfApiError, never> {
  return Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${CF_API}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });
      const body = (await res.json()) as CfEnvelope;
      if (!body.success) {
        const e = body.errors?.[0];
        throw new CfApiError({ status: res.status, cfMessage: e?.message, code: e?.code });
      }
      return body.result;
    },
    catch: (e) => (e instanceof CfApiError ? e : new CfApiError({ status: 0, cfMessage: (e as Error).message ?? String(e) })),
  });
}

function extractTunnelToken(result: unknown): Effect.Effect<string, DeployError, never> {
  if (typeof result === "string") return Effect.succeed(result);
  const obj = result as { token?: unknown };
  if (typeof obj.token === "string") return Effect.succeed(obj.token);
  return Effect.fail(new DeployError({ reason: "Unexpected Cloudflare tunnel token response" }));
}

// Same base62 algorithm as server/entry.ts generateRawKey.
function generateApiKey(): string {
  const raw = randomBytes(32);
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of raw) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) {
    result = chars[Number(value % base)] + result;
    value /= base;
  }
  while (result.length < 43) result = chars[0] + result;
  return `lxk_${result}`;
}

function preservedValue(file: string, key: string): string {
  try {
    if (!existsSync(file)) return "";
    const line = readFileSync(file, "utf-8").split("\n").find((l) => l.startsWith(`${key}=`));
    return line ? line.slice(key.length + 1) : "";
  } catch {
    return "";
  }
}

// Plain line reading in cooked mode; mirrors the promptLogin used by login.
function prompt(question: string, fallback = ""): Promise<string> {
  return new Promise((resolve) => {
    const done = (line: string) => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.off("SIGINT", onSigint);
      resolve(line.trim() || fallback);
    };
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl < 0) return;
      let line = buffer.slice(0, nl).replace(/\r$/, "");
      while (true) {
        const bs = line.search(/[\x7f\b]/);
        if (bs < 0) break;
        line = line.slice(0, Math.max(0, bs - 1)) + line.slice(bs + 1);
      }
      buffer = "";
      done(line);
    };
    const onEnd = () => done(fallback);
    const onSigint = () => {
      process.stdout.write("\n");
      process.exit(130);
    };
    process.stdout.write(question);
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.once("SIGINT", onSigint);
  });
}

function banner(flavorName: string, fullDomain: string): void {
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa Setup — ${flavorName}`);
  if (fullDomain) console.log(`  ${fullDomain}`);
  console.log("═══════════════════════════════════════════════════════");
}

// Bare-metal instructions replace the compose step (provisioning has run).

function finalBanner(flavorName: string, fullDomain: string, apiKey: string, imageTag?: string): void {
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa ${flavorName}`);
  if (fullDomain) console.log(`  https://${fullDomain}`);
  console.log(`  Image: ghcr.io/yohanesgre/lexa:${imageTag ?? "latest"}`);
  console.log(`  API key: ${apiKey}`);
  console.log("═══════════════════════════════════════════════════════");
}

// Keys the flavor env file owns. Compose precedence puts shell env above
// --env-file, so a stale exported var (e.g. another flavor's LXK_API_KEY
// still in the shell) would silently override the file — the file must be
// authoritative. LXK_IMAGE_TAG stays explicit per-run via opts.
const COMPOSE_MANAGED_KEYS = [
  "LXK_API_KEY", "VITE_LXK_API_KEY", "LXK_ADMIN_EMAILS", "LXK_ENV",
  "LXK_FORGE_DAEMON_TOKEN", "CF_TUNNEL_TOKEN", "GITHUB_APP_ID",
  "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET",
  "LXK_ACCESS_AUD", "LXK_ACCESS_TEAM", "LXK_MAX_BODY_MB", "LOG_LEVEL",
  "LXK_IMAGE_TAG",
];

function composeEnvFor(flavor: Flavor, opts: { imageTag?: string } = {}): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const key of COMPOSE_MANAGED_KEYS) delete env[key];
  env.COMPOSE_PROJECT_NAME = flavor.composeName;
  if (opts.imageTag) env.LXK_IMAGE_TAG = opts.imageTag;
  return env;
}

export function runCompose(flavor: Flavor, opts: { imageTag?: string; clean?: boolean } = {}): Effect.Effect<void, DeployError, never> {
  return Effect.gen(function* () {
    if (!existsSync("docker-compose.yml")) {
      return yield* new DeployError({ reason: "  ERROR: run from the repo root (docker-compose.yml not found)" });
    }
    const composeEnv = composeEnvFor(flavor, { imageTag: opts.imageTag });
    if (opts.clean) {
      console.log("==> Cleaning (--clean): removing containers + the data volume...");
      const down = spawnSync("docker", ["compose", ...flavor.composeFiles.split(" "), "--env-file", flavor.envFile, "down", "-v"], {
        stdio: "inherit",
        env: composeEnv,
      });
      if (down.status !== 0) {
        return yield* new DeployError({ reason: `  ERROR: docker compose down -v failed (status ${down.status ?? down.signal ?? "?"})` });
      }
    }
    console.log(`==> Pulling image${opts.imageTag ? ` (${opts.imageTag})` : " (latest)"} and starting...`);
    const composeArgs = ["compose", ...flavor.composeFiles.split(" "), "--env-file", flavor.envFile, "up", "-d", "--pull", "always", "--wait"];
    const docker = spawnSync("docker", composeArgs, {
      stdio: "inherit",
      env: composeEnv,
    });
    if (docker.status !== 0) {
      return yield* new DeployError({ reason: `  ERROR: docker compose failed (status ${docker.status ?? docker.signal ?? "?"})` });
    }
  });
}

export function downCompose(flavor: Flavor): Effect.Effect<void, DeployError, never> {
  return Effect.gen(function* () {
    if (!existsSync(flavor.envFile)) {
      console.log(`  No ${flavor.envFile} — never deployed, skipping compose down.`);
      return;
    }
    console.log("==> Stopping containers + removing the data volume (DB wiped)...");
    const composeEnv = composeEnvFor(flavor);
    const down = spawnSync("docker", ["compose", ...flavor.composeFiles.split(" "), "--env-file", flavor.envFile, "down", "-v"], {
      stdio: "inherit",
      env: composeEnv,
    });
    if (down.status !== 0) {
      return yield* new DeployError({ reason: `  ERROR: docker compose down -v failed (status ${down.status ?? down.signal ?? "?"})` });
    }
  });
}

// The deploy contract is the three compose files (image refs + volumes +
// tunnel) — embedded in the binary (few KB) so a clean machine needs no repo.
// Materialize them into ~/.lexa/deploy (prod) or ~/.lexa-staging/deploy and
// work from there. When running from source (dev shim, no embedded files),
// fall back to the local repo's compose files.
export function materializeCompose(flavorName: string, flags: Record<string, string | boolean>): string {
  const deployDir = flagStr(flags, "deploy-dir") || join(lexaDirFor(flavorName as LexaFlavor), "deploy");
  const entries = Object.entries(COMPOSE_FILES);
  if (entries.length === 0) {
    // Running from source: the repo's compose files are the contract.
    if (existsSync("docker-compose.yml")) return process.cwd();
    throw new Error("no embedded compose files and no docker-compose.yml in cwd (run `bun run compile:cli` or use --deploy-dir)");
  }
  mkdirSync(deployDir, { recursive: true });
  const flavorFiles = new Set(["docker-compose.yml", `docker-compose.${flavorName}.yml`]);
  for (const [rel, packed] of entries) {
    if (flavorFiles.has(rel)) {
      writeFileSync(join(deployDir, rel), gunzipSync(Buffer.from(packed, "base64")));
    } else {
      // Stale override files from another flavor (pre-split CLI wrote all three).
      rmSync(join(deployDir, rel), { force: true });
    }
  }
  return deployDir;
}

function requirePrereqs(): Effect.Effect<void, DeployError, never> {
  return Effect.gen(function* () {
    const docker = spawnSync("docker", ["--version"], { stdio: "ignore" });
    if (docker.status !== 0) {
      return yield* new DeployError({ reason: "  ERROR: docker not found — install Docker (https://docs.docker.com/engine/install/) then re-run" });
    }
    const compose = spawnSync("docker", ["compose", "version"], { stdio: "ignore" });
    if (compose.status !== 0) {
      return yield* new DeployError({ reason: "  ERROR: docker compose plugin not found — install docker-compose-plugin then re-run" });
    }
  });
}

function flagStr(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  return typeof v === "string" ? v : "";
}

export const cmdDeploy = Effect.fn("LexaCli/cmdDeploy")(function* (
  flags: Record<string, string | boolean>,
  positionals: string[],
) {
  const config = yield* CliConfigService;
  const domain = positionals[0] ?? "";
  const flavorName = positionals[1] ?? "";
  if (!domain) usage();
  const flavor = FLAVORS[flavorName];
  if (!flavor) usage();
  const lexaFlavor = flavorName as LexaFlavor;
  const isTTY = process.stdin.isTTY === true;

  const fullDomain = flavor.subdomain ? `${flavor.subdomain}.${domain}` : "";
  banner(flavorName, fullDomain);

  // Clean-machine flow: the binary embeds the compose files (image refs), so
  // no repo checkout is needed. Materialize them, then verify docker.
  const deployDir = yield* Effect.try({ try: () => materializeCompose(lexaFlavor, flags), catch: (e) => new DeployError({ reason: `  ERROR: ${(e as Error).message}` }) });
  process.chdir(deployDir);
  yield* requirePrereqs();

  // ── Cloudflare (staging/prod) ──
  const saved = yield* config.loadDeployCreds(lexaDirFor(lexaFlavor));
  let cfToken = flagStr(flags, "cf-token") || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
  if (!cfToken && saved?.cfToken) cfToken = saved.cfToken;
  if (!cfToken) {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: CF API token required — set CF_API_TOKEN/CLOUDFLARE_API_TOKEN or run on a terminal" });
    }
    console.log("── Cloudflare API Token ──");
    console.log("  Permissions: Cloudflare One → Cloudflare One Connectors (Write)");
    console.log("               Zone → DNS (Write)");
    console.log("               Access: Apps and Policies → Edit");
    console.log("               Access: Identity Providers → Read");
    cfToken = yield* Effect.promise(() => prompt("  Paste token: "));
    if (!cfToken) {
      return yield* new DeployError({ reason: "  ERROR: CF API token required" });
    }
  }

  // Account + Zone
  console.log("==> Account & Zone...");
  const accounts = (yield* cfFetch(cfToken, "/accounts")) as Array<{ id: string }>;
  if (accounts.length === 0) {
    return yield* new DeployError({ reason: "  ERROR: no Cloudflare accounts on this token — check the token permissions" });
  }
  const account = accounts[0].id;
  const zones = (yield* cfFetch(cfToken, `/zones?name=${domain}`)) as Array<{ id: string }>;
  if (zones.length === 0) {
    return yield* new DeployError({ reason: `  ERROR: no Cloudflare zone for "${domain}" — does the domain point at this CF account?` });
  }
  const zone = zones[0].id;
  console.log(`  Account: ${account}  Zone: ${zone}`);

  // Tunnel
  console.log("==> Tunnel...");
  const existingTunnels = (yield* cfFetch(cfToken, `/accounts/${account}/cfd_tunnel?name=${flavor.tunnelName}&is_deleted=false`)) as Array<{ id: string }>;
  let tunnel: string;
  if (existingTunnels.length > 0) {
    tunnel = existingTunnels[0].id;
    console.log(`  Using existing tunnel: ${tunnel}`);
  } else {
    const created = (yield* cfFetch(cfToken, `/accounts/${account}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: flavor.tunnelName, config_src: "cloudflare" }),
    })) as { id: string };
    tunnel = created.id;
    console.log(`  Created: ${tunnel}`);
  }
  const tunnelToken = yield* extractTunnelToken(yield* cfFetch(cfToken, `/accounts/${account}/cfd_tunnel/${tunnel}/token`));
  console.log(`  Tunnel: ${tunnel}  Token: ready`);

  // DNS
  console.log("==> DNS...");
  const existingDns = (yield* cfFetch(cfToken, `/zones/${zone}/dns_records?type=CNAME&name=${fullDomain}`)) as Array<{ id: string }>;
  if (existingDns.length > 0) {
    yield* cfFetch(cfToken, `/zones/${zone}/dns_records/${existingDns[0].id}`, { method: "DELETE" });
  }
  yield* cfFetch(cfToken, `/zones/${zone}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "CNAME", name: fullDomain, content: `${tunnel}.cfargotunnel.com`, proxied: true }),
  });
  console.log(`  ${fullDomain} → tunnel`);

  // Ingress — warn and continue on failure (manual config is still possible)
  console.log("==> Ingress...");
  yield* cfFetch(cfToken, `/accounts/${account}/cfd_tunnel/${tunnel}/configurations`, {
    method: "PUT",
    body: JSON.stringify({
      config: { ingress: [{ hostname: fullDomain, service: "http://app:3000" }, { service: "http_status:404" }] },
    }),
  }).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => console.log(`  ${fullDomain} → app:3000`)),
      onFailure: (e) =>
        Effect.sync(() => {
          console.log(`  ⚠ Ingress API call returned: ${e.message.slice(0, 200)}`);
          console.log(`  Configure manually: Zero Trust → Tunnels → ${flavor.tunnelName} → Public Hostnames`);
          console.log(`  Add: ${fullDomain} → http://app:3000`);
        }),
    }),
  );

  // ── Access (auth guard) ──
  console.log("==> Access (auth guard)...");

  let googleClientId = flagStr(flags, "google-client-id") || process.env.GOOGLE_CLIENT_ID || saved?.googleClientId || "";
  if (!googleClientId) {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: GOOGLE_CLIENT_ID required — set it or run on a terminal" });
    }
    googleClientId = yield* Effect.promise(() => prompt("  Google OAuth Client ID (.apps.googleusercontent.com): "));
  }
  let googleClientSecret = flagStr(flags, "google-client-secret") || process.env.GOOGLE_CLIENT_SECRET || saved?.googleClientSecret || "";
  if (!googleClientSecret) {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: GOOGLE_CLIENT_SECRET required — set it or run on a terminal" });
    }
    googleClientSecret = yield* Effect.promise(() => prompt("  Google OAuth Client Secret: "));
  }
  let cfTeamDomain = flagStr(flags, "team-domain") || process.env.CF_TEAM_DOMAIN || saved?.cfTeamDomain || "";
  if (!cfTeamDomain) {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: CF_TEAM_DOMAIN required — set it or run on a terminal" });
    }
    console.log("  Your CF Access team domain: Zero Trust → Settings → Custom Pages → Team domain");
    cfTeamDomain = yield* Effect.promise(() => prompt("  e.g. lexa.cloudflareaccess.com: "));
  }
  const redirectUri = `https://${cfTeamDomain}/cdn-cgi/access/callback`;
  console.log(`  Redirect URI: ${redirectUri}`);
  console.log("  (verify this matches your Google OAuth redirect in console)");

  // Google identity provider — per-flavor: staging and prod use different
  // Google OAuth clients, so each flavor owns its own named IdP.
  const idps = (yield* cfFetch(cfToken, `/accounts/${account}/access/identity_providers`)) as Array<{ id: string; type: string; name?: string }>;
  const idpName = `Google Login (${flavorName})`;
  const existingIdp = idps.find((i) => i.type === "google" && i.name === idpName);
  const idpBody = JSON.stringify({
    name: idpName,
    type: "google",
    config: { client_id: googleClientId, client_secret: googleClientSecret },
  });
  let idpId: string;
  if (existingIdp) {
    idpId = existingIdp.id;
    console.log(`  Updating existing Google IdP: ${idpId}`);
    yield* cfFetch(cfToken, `/accounts/${account}/access/identity_providers/${idpId}`, { method: "PUT", body: idpBody });
  } else {
    const created = (yield* cfFetch(cfToken, `/accounts/${account}/access/identity_providers`, {
      method: "POST",
      body: idpBody,
    })) as { id: string };
    idpId = created.id;
    console.log(`  Created Google IdP: ${idpId}`);
  }

  // Access application — reuse if domain already exists
  const existingApps = (yield* cfFetch(cfToken, `/accounts/${account}/access/apps?domain=${fullDomain}`)) as Array<{ id: string }>;
  let appId: string;
  if (existingApps.length > 0) {
    appId = existingApps[0].id;
    console.log(`  Using existing Access app: ${appId}`);
  } else {
    const created = (yield* cfFetch(cfToken, `/accounts/${account}/access/apps`, {
      method: "POST",
      body: JSON.stringify({
        name: `Lexa (${flavorName})`,
        domain: fullDomain,
        type: "self_hosted",
        session_duration: "24h",
        allowed_idps: [idpId],
        auto_redirect_to_identity: true,
      }),
    })) as { id: string };
    appId = created.id;
    console.log(`  Created Access app: ${appId}`);
  }

  // Policy — restrict to email domain, reuse if exists
  let emailDomain = flagStr(flags, "email-domain") || saved?.emailDomain || "";
  if (!emailDomain) {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: allowed email domain required — run on a terminal or save it via a previous deploy" });
    }
    emailDomain = yield* Effect.promise(() => prompt("  Allowed email domain (e.g. yohanesgre.com): "));
  }
  const policyBody = JSON.stringify({
    name: `Allow @${emailDomain}`,
    decision: "allow",
    include: [{ email_domain: { domain: emailDomain } }],
    precedence: 1,
  });
  const existingPolicies = (yield* cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies`)) as Array<{ id: string; precedence?: number; app_count?: number; reusable?: boolean }>;
  if (existingPolicies.length > 0) {
    const row = existingPolicies[0];
    // App-scoped policy lists include REUSABLE policies too, and reusable
    // policies must be updated through the account-level endpoint — the
    // app-scoped PUT rejects them (12130). Reusable rows carry app_count
    // (and typically reusable: true) and no precedence; app-scoped rows
    // carry precedence.
    if (row.reusable === true || row.app_count !== undefined) {
      console.log(`  Updating existing reusable policy: ${row.id}`);
      yield* cfFetch(cfToken, `/accounts/${account}/access/policies/${row.id}`, {
        method: "PUT",
        // Reusable policy bodies have no precedence (per-app ordering only).
        body: JSON.stringify({
          name: `Allow @${emailDomain}`,
          decision: "allow",
          include: [{ email_domain: { domain: emailDomain } }],
        }),
      });
    } else {
      console.log(`  Updating existing policy: ${row.id}`);
      yield* cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies/${row.id}`, {
        method: "PUT",
        body: policyBody,
      });
    }
  } else {
    yield* cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies`, { method: "POST", body: policyBody });
  }
  console.log(`  Policy: allow @${emailDomain}`);

  // ── Admin user + API key ──
  console.log("");
  console.log("── Admin user ──");
  console.log("  First Google login with this email will be auto-promoted to admin.");
  // Prefer values already written by `bun run setup --prod` so re-deploys
  // don't clobber a provisioned key or admin list.
  const existingAdmin = preservedValue(flavor.envFile, "LXK_ADMIN_EMAILS");
  const existingKey = preservedValue(flavor.envFile, "LXK_API_KEY");
  let adminEmail = flagStr(flags, "admin-email") || existingAdmin || "";
  if (!adminEmail && !isTTY) {
    return yield* new DeployError({ reason: "  ERROR: admin email required — run on a terminal or bootstrap with `bun run setup --" + flavorName + " --yes`" });
  }
  if (!adminEmail) {
    adminEmail = yield* Effect.promise(() => prompt(`  Admin email${existingAdmin ? ` [${existingAdmin}]` : ""}: `));
    if (!adminEmail) adminEmail = existingAdmin;
  }

  console.log("");
  console.log("── API Key ──");
  let apiKey = flagStr(flags, "api-key") || existingKey || "";
  if (apiKey) {
    console.log(`  Reusing key from ${flavor.envFile}: ${apiKey.slice(0, 10)}…`);
  } else {
    if (!isTTY) {
      return yield* new DeployError({ reason: "  ERROR: API key required — run on a terminal or bootstrap with `bun run setup --" + flavorName + " --yes`" });
    }
    apiKey = yield* Effect.promise(() => prompt("  API key (lxk_...) [Enter to generate]: "));
    if (!apiKey) {
      apiKey = generateApiKey();
      console.log(`  Generated: ${apiKey}`);
    }
  }

  // Preserve existing GitHub sync config across re-runs (deploy rewrites the env file).
  const githubAppId = preservedValue(flavor.envFile, "GITHUB_APP_ID");
  const githubWebhookSecret = preservedValue(flavor.envFile, "GITHUB_WEBHOOK_SECRET");

  // LXK_ACCESS_TEAM is derived from the CF Access team domain (subdomain
  // before .cloudflareaccess.com) so the "Sign out" link always matches the
  // team the Access app lives under — never hand-set.
  const accessTeam = cfTeamDomain.replace(/\.cloudflareaccess\.com$/, "");

  // Carry forward any hand-added keys (LOG_LEVEL, LXK_MAX_BODY_MB,
  // LXK_ACCESS_AUD, ...) — the rewrite below only owns its own set.
  const rewrittenKeys = new Set(["LXK_API_KEY", "VITE_LXK_API_KEY", "LXK_ADMIN_EMAILS", "LXK_ENV", "CF_TUNNEL_TOKEN", "GITHUB_APP_ID", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET", "LXK_ACCESS_TEAM"]);
  const carried = existsSync(flavor.envFile)
    ? readFileSync(flavor.envFile, "utf-8")
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => {
          const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(l);
          return m && !rewrittenKeys.has(m[1]) && !l.startsWith("#");
        })
    : [];

  const envContent = [
    ...carried,
    `LXK_API_KEY=${apiKey}`,
    `VITE_LXK_API_KEY=${apiKey}`,
    `LXK_ADMIN_EMAILS=${adminEmail}`,
    `LXK_ENV=${flavorName}`,
    `CF_TUNNEL_TOKEN=${tunnelToken}`,
    `LXK_ACCESS_TEAM=${accessTeam}`,
    `GITHUB_APP_ID=${githubAppId}`,
    "GITHUB_PRIVATE_KEY_FILE=/app/github-app.private-key.pem",
    `GITHUB_WEBHOOK_SECRET=${githubWebhookSecret}`,
    "",
  ].join("\n");
  writeFileSync(flavor.envFile, envContent, { mode: 0o600 });
  console.log(`  Wrote ${flavor.envFile}`);

  // GitHub sync needs the PEM in the deploy dir (prod compose mounts it ro).
  // On a machine without the PEM file it won't exist — warn instead of
  // letting Docker create an empty directory at the mount source.
  if (githubAppId && !existsSync(join(process.cwd(), "github-app.private-key.pem"))) {
    console.warn("  WARNING: GITHUB_APP_ID is set but github-app.private-key.pem is missing —");
    console.warn("           copy the PEM into the deploy dir (or set GITHUB_PRIVATE_KEY) or GitHub sync will fail.");
  }

  // ── Start ──
  yield* config.saveDeployCreds({
    cfToken: cfToken || undefined,
    googleClientId: googleClientId || undefined,
    googleClientSecret: googleClientSecret || undefined,
    cfTeamDomain: cfTeamDomain || undefined,
    emailDomain: emailDomain || undefined,
  }, lexaDirFor(lexaFlavor));

  const imageTag = flagStr(flags, "image") || undefined;
  const clean = flags.clean === true;
  if (clean && isTTY) {
    console.log("");
    console.log("  ⚠ --clean removes the data volume (lexa-data) — the DB will be recreated empty.");
    const answer = yield* Effect.promise(() => prompt("  Type 'clean' to confirm: "));
    if (answer !== "clean") {
      console.log("  Aborted (confirmation did not match).");
      process.exit(1);
    }
  }

  yield* runCompose(flavor, { imageTag, clean });
  finalBanner(flavorName, fullDomain, apiKey, imageTag);
});

// Best-effort CF helpers for teardown: a failed lookup logs a warning and
// yields nothing to delete; a failed delete logs a warning and continues —
// teardown never aborts for a half-gone Cloudflare state.
function listResources<T>(cfToken: string, label: string, path: string): Effect.Effect<Array<T>, never, never> {
  return cfFetch(cfToken, path).pipe(
    Effect.matchEffect({
      onSuccess: (v) => Effect.succeed(v as Array<T>),
      onFailure: (e) =>
        Effect.sync(() => {
          console.warn(`  ⚠ ${label} lookup failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
          return [] as Array<T>;
        }),
    }),
  );
}

function deleteResource(cfToken: string, label: string, path: string): Effect.Effect<void, never, never> {
  return cfFetch(cfToken, path, { method: "DELETE" }).pipe(
    Effect.matchEffect({
      onSuccess: () => Effect.sync(() => console.log(`  Deleted ${label}`)),
      onFailure: (e) =>
        Effect.sync(() => {
          console.warn(`  ⚠ Delete ${label} failed: ${e.message.slice(0, 200)} — remove manually if needed.`);
        }),
    }),
  );
}

function teardownCloudflare(cfToken: string, domain: string, fullDomain: string, flavor: Flavor, flavorName: string): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    console.log("==> Cloudflare teardown...");
    const accounts = yield* listResources<{ id: string }>(cfToken, "Cloudflare account", "/accounts");
    const account = accounts[0]?.id;
    if (!account) return;
    const zones = yield* listResources<{ id: string }>(cfToken, "zone", `/zones?name=${domain}`);
    const zone = zones[0]?.id;
    if (zone) {
      const dns = yield* listResources<{ id: string }>(cfToken, "DNS", `/zones/${zone}/dns_records?type=CNAME&name=${fullDomain}`);
      for (const record of dns) {
        yield* deleteResource(cfToken, `DNS ${record.id}`, `/zones/${zone}/dns_records/${record.id}`);
      }
      if (dns.length === 0) console.log(`  No DNS records for ${fullDomain} — nothing to delete.`);
    } else {
      console.warn(`  ⚠ No Cloudflare zone for "${domain}" — DNS left in place, remove manually.`);
    }
    const tunnels = yield* listResources<{ id: string }>(cfToken, "tunnel", `/accounts/${account}/cfd_tunnel?name=${flavor.tunnelName}&is_deleted=false`);
    for (const tunnel of tunnels) {
      yield* deleteResource(cfToken, `tunnel ${tunnel.id}`, `/accounts/${account}/cfd_tunnel/${tunnel.id}`);
    }
    if (tunnels.length === 0) console.log(`  No tunnel "${flavor.tunnelName}" — nothing to delete.`);
    const apps = yield* listResources<{ id: string }>(cfToken, "Access app", `/accounts/${account}/access/apps?domain=${fullDomain}`);
    for (const app of apps) {
      const policies = yield* listResources<{ id: string; reusable?: boolean; app_count?: number }>(cfToken, "policy", `/accounts/${account}/access/apps/${app.id}/policies`);
      for (const policy of policies) {
        if (policy.reusable === true || policy.app_count !== undefined) {
          yield* deleteResource(cfToken, `reusable policy ${policy.id}`, `/accounts/${account}/access/policies/${policy.id}`);
        } else {
          yield* deleteResource(cfToken, `policy ${policy.id}`, `/accounts/${account}/access/apps/${app.id}/policies/${policy.id}`);
        }
      }
      yield* deleteResource(cfToken, `Access app ${app.id}`, `/accounts/${account}/access/apps/${app.id}`);
    }
    if (apps.length === 0) console.log(`  No Access app for ${fullDomain} — nothing to delete.`);
    const idps = yield* listResources<{ id: string; type: string; name?: string }>(cfToken, "IdP", `/accounts/${account}/access/identity_providers`);
    const idp = idps.find((i) => i.type === "google" && i.name === `Google Login (${flavorName})`);
    if (idp) {
      yield* deleteResource(cfToken, `IdP ${idp.id}`, `/accounts/${account}/access/identity_providers/${idp.id}`);
    } else {
      console.log(`  No "Google Login (${flavorName})" IdP — nothing to delete.`);
    }
  });
}

export const cmdUndeploy = Effect.fn("LexaCli/cmdUndeploy")(function* (
  flags: Record<string, string | boolean>,
  positionals: string[],
) {
  const config = yield* CliConfigService;
  const domain = positionals[0] ?? "";
  const flavorName = positionals[1] ?? "";
  if (!domain) usage();
  const flavor = FLAVORS[flavorName];
  if (!flavor) usage();
  const lexaFlavor = flavorName as LexaFlavor;
  const isTTY = process.stdin.isTTY === true;

  const fullDomain = flavor.subdomain ? `${flavor.subdomain}.${domain}` : domain;
  console.log(`==> Undeploy ${flavorName} (${fullDomain})`);

  if (isTTY) {
    console.log("");
    console.log("  ⚠ Undeploy removes: containers + the data volume (DB wiped), Cloudflare");
    console.log("     resources (DNS, tunnel, Access app, IdP), and local state.");
    const answer = yield* Effect.promise(() => prompt("  Type 'undeploy' to confirm: "));
    if (answer !== "undeploy") {
      console.log("  Aborted (confirmation did not match).");
      process.exit(1);
    }
  } else if (flags.yes !== true) {
    return yield* new DeployError({ reason: "  ERROR: destructive teardown requires --yes on a non-TTY (or run on a terminal to confirm)" });
  }

  const deployDir = yield* Effect.try({ try: () => materializeCompose(lexaFlavor, flags), catch: (e) => new DeployError({ reason: `  ERROR: ${(e as Error).message}` }) });
  process.chdir(deployDir);
  yield* downCompose(flavor);

  const saved = yield* config.loadDeployCreds(lexaDirFor(lexaFlavor));
  const cfToken = flagStr(flags, "cf-token") || process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || saved?.cfToken || "";
  if (cfToken) {
    yield* teardownCloudflare(cfToken, domain, fullDomain, flavor, flavorName);
  } else {
    console.warn("  ⚠ No Cloudflare API token — CF resources (DNS, tunnel, Access app, IdP) must be removed manually.");
  }

  console.log("==> Local state...");
  if (existsSync(deployDir)) rmSync(deployDir, { recursive: true, force: true });
  console.log(`  Removed deploy dir: ${deployDir}`);
  yield* config.clearDeployCreds(lexaDirFor(lexaFlavor));
  console.log(`  Removed deploy creds (${join(lexaDirFor(lexaFlavor), "config.json")})`);

  console.log(`  Undeployed ${flavorName} (${fullDomain}) — containers, volume, CF resources, and local state removed.`);
});
