// lexa-cli deploy — Docker Compose + cloudflared tunnel + Cloudflare Access
// provisioning. TypeScript port of the former scripts/setup.sh. Deploy
// credentials persist in ~/.lexa/config.json under the `deploy` key, so
// deploy works without a saved login (url/apiKey).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadDeployCreds, saveDeployCreds } from "./config";

const CF_API = "https://api.cloudflare.com/client/v4";

interface Flavor {
  subdomain: string;
  tunnelName: string;
  composeName: string;
  composeFiles: string;
  envFile: string;
}

const FLAVORS: Record<string, Flavor> = {
  dev: { subdomain: "", tunnelName: "", composeName: "lexa-dev", composeFiles: "-f docker-compose.yml", envFile: ".env" },
  staging: { subdomain: "lexa-preview", tunnelName: "lexa-staging", composeName: "lexa-staging", composeFiles: "-f docker-compose.yml -f docker-compose.staging.yml", envFile: ".env.staging" },
  prod: { subdomain: "lexa", tunnelName: "lexa-prod", composeName: "lexa-prod", composeFiles: "-f docker-compose.yml -f docker-compose.prod.yml", envFile: ".env.prod" },
};

function usage(): never {
  console.error("Usage: lexa-cli deploy <domain> [dev|staging|prod] [--bare]");
  console.error("  dev     — local, no tunnel, .env");
  console.error("  staging — remote, lexa-preview.<domain>, .env.staging");
  console.error("  prod    — remote, lexa.<domain>, .env.prod");
  process.exit(1);
}

// Cloudflare JSON envelope; `result` stays unknown — cast at each call site.
interface CfEnvelope {
  success: boolean;
  errors: Array<{ code?: number; message?: string }>;
  result: unknown;
}

async function cfFetch(token: string, path: string, init?: RequestInit): Promise<unknown> {
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
    throw new Error(`Cloudflare API error: ${e?.message ?? res.status}${e?.code !== undefined ? ` (${e.code})` : ""}`);
  }
  return body.result;
}

function extractTunnelToken(result: unknown): string {
  if (typeof result === "string") return result;
  const obj = result as { token?: unknown };
  if (typeof obj.token === "string") return obj.token;
  throw new Error("Unexpected Cloudflare tunnel token response");
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

function loadEnvIntoProcess(file: string): void {
  try {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) process.env[m[1]] = m[2];
    }
  } catch {
    // best-effort — the wizard already reported its own errors
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

// Bare-metal instructions replace the compose step (setup.sh prints them
// only after the wizard/provisioning has run).
function printBare(flavorName: string, apiKey: string): void {
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa ${flavorName} — bare metal`);
  console.log("");
  console.log("  bun run setup");
  console.log("  rm -f data/lexa.db*");
  console.log("  bun dev:full");
  console.log("");
  console.log(`  API key: ${apiKey || "run bun run setup"}`);
  console.log("═══════════════════════════════════════════════════════");
}

function finalBanner(flavorName: string, fullDomain: string, apiKey: string): void {
  console.log("");
  console.log("═══════════════════════════════════════════════════════");
  console.log(`  Lexa ${flavorName}`);
  if (fullDomain) console.log(`  https://${fullDomain}`);
  console.log(`  API key: ${apiKey}`);
  console.log("═══════════════════════════════════════════════════════");
}

function runCompose(flavor: Flavor): void {
  if (!existsSync("docker-compose.yml")) {
    console.error("  ERROR: run from the repo root (docker-compose.yml not found)");
    process.exit(1);
  }
  console.log("==> Building and starting...");
  const composeArgs = ["compose", ...flavor.composeFiles.split(" "), "--env-file", flavor.envFile, "up", "-d", "--build", "--wait"];
  const docker = spawnSync("docker", composeArgs, {
    stdio: "inherit",
    env: { ...process.env, COMPOSE_PROJECT_NAME: flavor.composeName },
  });
  if (docker.status !== 0) {
    console.error(`  ERROR: docker compose failed (status ${docker.status ?? docker.signal ?? "?"})`);
    process.exit(1);
  }
}

async function healthCheck(): Promise<void> {
  await new Promise((r) => setTimeout(r, 3000));
  let healthy = false;
  try {
    const res = await fetch("http://localhost:3000/api/health", { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { ok?: boolean };
    healthy = body.ok === true;
  } catch {
    healthy = false;
  }
  console.log(`  Local: ${healthy ? "OK" : "FAILED"}`);
}

export async function cmdDeploy(flags: Record<string, string | boolean>, positionals: string[]): Promise<void> {
  const domain = positionals[0] ?? "";
  const flavorName = positionals[1] ?? "dev";
  if (!domain) usage();
  const flavor = FLAVORS[flavorName];
  if (!flavor) usage();
  const bare = flags.bare === true;
  const isTTY = process.stdin.isTTY === true;

  const fullDomain = flavor.subdomain ? `${flavor.subdomain}.${domain}` : "";
  banner(flavorName, fullDomain);

  if (flavorName === "dev") {
    if (!existsSync("docker-compose.yml")) {
      console.error("  ERROR: run from the repo root (docker-compose.yml not found)");
      process.exit(1);
    }
    console.log("");
    console.log("── Lexa application setup (dev) ──");
    console.log("  Running: bun run setup");
    console.log("  (Admin email, API key, migrations, and seed are handled by the wizard.)");
    const wizard = spawnSync("bun", ["run", "setup"], { stdio: "inherit", cwd: process.cwd() });
    if (wizard.status !== 0) process.exit(wizard.status ?? 1);
    loadEnvIntoProcess(".env");
    if (bare) {
      printBare(flavorName, "");
      return;
    }
    runCompose(flavor);
    await healthCheck();
    finalBanner(flavorName, "", process.env.LXK_API_KEY ?? "");
    return;
  }

  // ── Cloudflare (staging/prod) ──
  const saved = loadDeployCreds();
  let cfToken = process.env.CF_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN || "";
  if (!cfToken && saved?.cfToken) cfToken = saved.cfToken;
  if (!cfToken) {
    if (!isTTY) {
      console.error("  ERROR: CF API token required — set CF_API_TOKEN/CLOUDFLARE_API_TOKEN or run on a terminal");
      process.exit(1);
    }
    console.log("── Cloudflare API Token ──");
    console.log("  Permissions: Cloudflare One → Cloudflare One Connectors (Write)");
    console.log("               Zone → DNS (Write)");
    console.log("               Access: Apps and Policies → Edit");
    console.log("               Access: Identity Providers → Read");
    cfToken = await prompt("  Paste token: ");
    if (!cfToken) {
      console.error("  ERROR: CF API token required");
      process.exit(1);
    }
  }

  // Account + Zone
  console.log("==> Account & Zone...");
  const accounts = (await cfFetch(cfToken, "/accounts")) as Array<{ id: string }>;
  const account = accounts[0].id;
  const zones = (await cfFetch(cfToken, `/zones?name=${domain}`)) as Array<{ id: string }>;
  const zone = zones[0].id;
  console.log(`  Account: ${account}  Zone: ${zone}`);

  // Tunnel
  console.log("==> Tunnel...");
  const existingTunnels = (await cfFetch(cfToken, `/accounts/${account}/cfd_tunnel?name=${flavor.tunnelName}&is_deleted=false`)) as Array<{ id: string }>;
  let tunnel: string;
  if (existingTunnels.length > 0) {
    tunnel = existingTunnels[0].id;
    console.log(`  Using existing tunnel: ${tunnel}`);
  } else {
    const created = (await cfFetch(cfToken, `/accounts/${account}/cfd_tunnel`, {
      method: "POST",
      body: JSON.stringify({ name: flavor.tunnelName, config_src: "cloudflare" }),
    })) as { id: string };
    tunnel = created.id;
    console.log(`  Created: ${tunnel}`);
  }
  const tunnelToken = extractTunnelToken(await cfFetch(cfToken, `/accounts/${account}/cfd_tunnel/${tunnel}/token`));
  console.log(`  Tunnel: ${tunnel}  Token: ready`);

  // DNS
  console.log("==> DNS...");
  const existingDns = (await cfFetch(cfToken, `/zones/${zone}/dns_records?type=CNAME&name=${fullDomain}`)) as Array<{ id: string }>;
  if (existingDns.length > 0) {
    await cfFetch(cfToken, `/zones/${zone}/dns_records/${existingDns[0].id}`, { method: "DELETE" });
  }
  await cfFetch(cfToken, `/zones/${zone}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "CNAME", name: fullDomain, content: `${tunnel}.cfargotunnel.com`, proxied: true }),
  });
  console.log(`  ${fullDomain} → tunnel`);

  // Ingress — warn and continue on failure (manual config is still possible)
  console.log("==> Ingress...");
  try {
    await cfFetch(cfToken, `/accounts/${account}/cfd_tunnel/${tunnel}/configurations`, {
      method: "PUT",
      body: JSON.stringify({
        config: { ingress: [{ hostname: fullDomain, service: "http://app:3000" }, { service: "http_status:404" }] },
      }),
    });
    console.log(`  ${fullDomain} → app:3000`);
  } catch (e) {
    console.log(`  ⚠ Ingress API call returned: ${(e as Error).message.slice(0, 200)}`);
    console.log(`  Configure manually: Zero Trust → Tunnels → ${flavor.tunnelName} → Public Hostnames`);
    console.log(`  Add: ${fullDomain} → http://app:3000`);
  }

  // ── Access (auth guard) ──
  console.log("==> Access (auth guard)...");

  let googleClientId = process.env.GOOGLE_CLIENT_ID || saved?.googleClientId || "";
  if (!googleClientId) {
    if (!isTTY) {
      console.error("  ERROR: GOOGLE_CLIENT_ID required — set it or run on a terminal");
      process.exit(1);
    }
    googleClientId = await prompt("  Google OAuth Client ID (.apps.googleusercontent.com): ");
  }
  let googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || saved?.googleClientSecret || "";
  if (!googleClientSecret) {
    if (!isTTY) {
      console.error("  ERROR: GOOGLE_CLIENT_SECRET required — set it or run on a terminal");
      process.exit(1);
    }
    googleClientSecret = await prompt("  Google OAuth Client Secret: ");
  }
  let cfTeamDomain = process.env.CF_TEAM_DOMAIN || saved?.cfTeamDomain || "";
  if (!cfTeamDomain) {
    if (!isTTY) {
      console.error("  ERROR: CF_TEAM_DOMAIN required — set it or run on a terminal");
      process.exit(1);
    }
    console.log("  Your CF Access team domain: Zero Trust → Settings → Custom Pages → Team domain");
    cfTeamDomain = await prompt("  e.g. lexa.cloudflareaccess.com: ");
  }
  const redirectUri = `https://${cfTeamDomain}/cdn-cgi/access/callback`;
  console.log(`  Redirect URI: ${redirectUri}`);
  console.log("  (verify this matches your Google OAuth redirect in console)");

  // Google identity provider — reuse existing if present
  const idps = (await cfFetch(cfToken, `/accounts/${account}/access/identity_providers`)) as Array<{ id: string; type: string }>;
  const existingIdp = idps.find((i) => i.type === "google");
  const idpBody = JSON.stringify({
    name: "Google Login",
    type: "google",
    config: { client_id: googleClientId, client_secret: googleClientSecret },
  });
  let idpId: string;
  if (existingIdp) {
    idpId = existingIdp.id;
    console.log(`  Updating existing Google IdP: ${idpId}`);
    await cfFetch(cfToken, `/accounts/${account}/access/identity_providers/${idpId}`, { method: "PUT", body: idpBody });
  } else {
    const created = (await cfFetch(cfToken, `/accounts/${account}/access/identity_providers`, {
      method: "POST",
      body: idpBody,
    })) as { id: string };
    idpId = created.id;
    console.log(`  Created Google IdP: ${idpId}`);
  }

  // Access application — reuse if domain already exists
  const existingApps = (await cfFetch(cfToken, `/accounts/${account}/access/apps?domain=${fullDomain}`)) as Array<{ id: string }>;
  let appId: string;
  if (existingApps.length > 0) {
    appId = existingApps[0].id;
    console.log(`  Using existing Access app: ${appId}`);
  } else {
    const created = (await cfFetch(cfToken, `/accounts/${account}/access/apps`, {
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
  let emailDomain = saved?.emailDomain || "";
  if (!emailDomain) {
    if (!isTTY) {
      console.error("  ERROR: allowed email domain required — run on a terminal or save it via a previous deploy");
      process.exit(1);
    }
    emailDomain = await prompt("  Allowed email domain (e.g. yohanesgre.com): ");
  }
  const policyBody = JSON.stringify({
    name: `Allow @${emailDomain}`,
    decision: "allow",
    include: [{ email_domain: { domain: emailDomain } }],
    precedence: 1,
  });
  const existingPolicies = (await cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies`)) as Array<{ id: string }>;
  if (existingPolicies.length > 0) {
    console.log(`  Updating existing policy: ${existingPolicies[0].id}`);
    await cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies/${existingPolicies[0].id}`, {
      method: "PUT",
      body: policyBody,
    });
  } else {
    await cfFetch(cfToken, `/accounts/${account}/access/apps/${appId}/policies`, { method: "POST", body: policyBody });
  }
  console.log(`  Policy: allow @${emailDomain}`);

  // ── Admin user + API key ──
  console.log("");
  console.log("── Admin user ──");
  console.log("  First Google login with this email will be auto-promoted to admin.");
  if (!isTTY) {
    console.error("  ERROR: admin email required — run on a terminal");
    process.exit(1);
  }
  const adminEmail = await prompt("  Admin email: ");

  console.log("");
  console.log("── API Key ──");
  if (!isTTY) {
    console.error("  ERROR: API key required — run on a terminal");
    process.exit(1);
  }
  let apiKey = await prompt("  API key (lxk_...) [Enter to generate]: ");
  if (!apiKey) {
    apiKey = generateApiKey();
    console.log(`  Generated: ${apiKey}`);
  }

  // Preserve existing GitHub sync config across re-runs (deploy rewrites the env file).
  const githubAppId = preservedValue(flavor.envFile, "GITHUB_APP_ID");
  const githubWebhookSecret = preservedValue(flavor.envFile, "GITHUB_WEBHOOK_SECRET");

  const envContent = [
    `LXK_API_KEY=${apiKey}`,
    `VITE_LXK_API_KEY=${apiKey}`,
    `LXK_ADMIN_EMAILS=${adminEmail}`,
    `CF_TUNNEL_TOKEN=${tunnelToken}`,
    `GITHUB_APP_ID=${githubAppId}`,
    "GITHUB_PRIVATE_KEY_FILE=/app/github-app.private-key.pem",
    `GITHUB_WEBHOOK_SECRET=${githubWebhookSecret}`,
    "",
  ].join("\n");
  writeFileSync(flavor.envFile, envContent, { mode: 0o600 });
  console.log(`  Wrote ${flavor.envFile}`);

  // ── Start ──
  saveDeployCreds({
    cfToken: cfToken || undefined,
    googleClientId: googleClientId || undefined,
    googleClientSecret: googleClientSecret || undefined,
    cfTeamDomain: cfTeamDomain || undefined,
    emailDomain: emailDomain || undefined,
  });

  if (bare) {
    printBare(flavorName, apiKey);
    return;
  }
  runCompose(flavor);
  await healthCheck();
  finalBanner(flavorName, fullDomain, apiKey);
}
