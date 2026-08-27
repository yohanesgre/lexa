// lexa-cli github — validate, configure, and round-trip the GitHub sync
// integration. The server's settings DB is the single source of truth; the
// server env is first-boot bootstrap only (mirrored into the DB at boot when
// unset). status/setup default to the live server via the API (login
// required); --local reads/writes the env-file bootstrap; check drives the
// Lexa→GitHub leg of the RELEASE.md acceptance round-trip against a live
// server.
import { Effect } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LexaClient, type GithubSettingsInfo } from "./api";

const OWNED_KEYS = new Set(["GITHUB_APP_ID", "GITHUB_PRIVATE_KEY", "GITHUB_PRIVATE_KEY_FILE", "GITHUB_WEBHOOK_SECRET"]);

function flagStr(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  return typeof v === "string" ? v : "";
}

function envFileFor(flags: Record<string, string | boolean>): string {
  return flagStr(flags, "env-file") || ".env";
}

function readEnv(file: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    if (!existsSync(file)) return out;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out.set(m[1]!, m[2]!);
    }
  } catch { /* unreadable file = empty map */ }
  return out;
}

function pemHeaderOk(pemPath: string): boolean {
  try {
    const first = readFileSync(pemPath!, "utf-8").split("\n")[0]!.trim();
    return first === "-----BEGIN RSA PRIVATE KEY-----" || first === "-----BEGIN PRIVATE KEY-----";
  } catch {
    return false;
  }
}

function generateSecret(): string {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  let value = 0n;
  for (const b of randomBytes(24)) value = (value << 8n) | BigInt(b);
  let result = "";
  const base = 62n;
  while (value > 0n) {
    result = chars[Number(value % base)] + result;
    value /= base;
  }
  return result.padStart(32, "0");
}

// Plain line reading in cooked mode; mirrors the prompt used by deploy.
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
      buffer += chunk.toString();
      const nl = buffer.indexOf("\n");
      if (nl >= 0) {
        process.stdin.pause();
        done(buffer.slice(0, nl));
      }
    };
    const onEnd = () => done(buffer);
    const onSigint = () => {
      process.exit(130);
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.on("SIGINT", onSigint);
    process.stdout.write(question);
  });
}

function printStatus(env: Map<string, string>): void {
  const appId = env.get("GITHUB_APP_ID") ?? "";
  const inlineKey = env.get("GITHUB_PRIVATE_KEY") ?? "";
  const keyFile = env.get("GITHUB_PRIVATE_KEY_FILE") ?? "";
  const secret = env.get("GITHUB_WEBHOOK_SECRET") ?? "";
  let missing = 0;

  const row = (ok: boolean, label: string, detail: string): void => {
    console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
    if (!ok) missing++;
  };

  row(appId !== "", "GITHUB_APP_ID", appId || "missing");
  if (inlineKey) {
    row(inlineKey.startsWith("-----BEGIN"), "GITHUB_PRIVATE_KEY", inlineKey.length > 24 ? `${inlineKey.slice(0, 24)}…` : "invalid PEM");
  } else if (keyFile) {
    const exists = existsSync(keyFile);
    row(exists && pemHeaderOk(keyFile), "GITHUB_PRIVATE_KEY_FILE", exists ? keyFile : `file not found: ${keyFile}`);
  } else {
    row(false, "GITHUB_PRIVATE_KEY(_FILE)", "missing — set one or the other (file recommended)");
  }
  row(secret !== "" && secret.length >= 16, "GITHUB_WEBHOOK_SECRET", secret ? `${secret.length} chars` : "missing");

  if (missing === 0) {
    console.log("  Config looks complete — this is the first-boot BOOTSTRAP.");
    console.log("  The server imports it only while its settings DB is unset; once");
    console.log("  the server has DB config (web Settings, or a logged-in setup),");
    console.log("  env-file edits are inert. Live state: lexa-cli github status");
  } else {
    console.log(`  ${missing} var(s) missing or invalid — fix with:`);
    console.log("    lexa-cli github setup        (logged in — applies via the server API)");
    console.log("    lexa-cli github setup --local [--env-file <path>]  (env bootstrap)");
    console.log("  Full manual guide: docs/GITHUB_SETUP.md");
  }
}

// The server's effective settings (from GET/PUT /api/settings/github). The
// DB is the source of truth, so "set" means the server has a usable value.
function printServerState(s: GithubSettingsInfo): void {
  console.log(`  ${s.appId !== "" ? "✅" : "❌"} GitHub App ID — ${s.appId || "missing"}`);
  console.log(`  ${s.privateKeySet ? "✅" : "❌"} Private key — ${s.privateKeySet ? "set (server DB)" : "missing"}`);
  console.log(`  ${s.webhookSecretSet ? "✅" : "❌"} Webhook secret — ${s.webhookSecretSet ? "set (server DB)" : "missing"}`);
  console.log(`  Config source: ${s.source} — the server DB is the source of truth.`);
}

export const cmdGithubStatus = Effect.fn("LexaCli/cmdGithubStatus")(function* (flags: Record<string, string | boolean>, client: LexaClient | null = null) {
  if (flags.local === true) {
    const file = envFileFor(flags);
    console.log(`==> Reading ${file}`);
    yield* Effect.sync(() => printStatus(readEnv(file)));
    return;
  }
  // Default: the live server — the settings DB is the source of truth.
  if (!client) throw new Error("Not logged in. Run: lexa-cli login [--url <base>] [--key <lxk_...>], or use --local to check the env file.");
  const s = yield* client.getGithubSettings();
  console.log("==> GitHub sync — server state (GET /api/settings/github)");
  printServerState(s);
  if (!s.appId || !s.privateKeySet || !s.webhookSecretSet) {
    console.log("  Missing pieces — fix with: lexa-cli github setup");
  } else {
    console.log("  Config complete. Run `lexa-cli github check <slug> <owner/repo>`");
    console.log("  for the round-trip. Changes apply immediately (no restart).");
  }
});

export const cmdGithubSetup = Effect.fn("LexaCli/cmdGithubSetup")(function* (flags: Record<string, string | boolean>, client: LexaClient | null = null) {
  const file = envFileFor(flags);
  const env = readEnv(file);
  const isTTY = process.stdin.isTTY === true;
  const local = flags.local === true;
  // Default: the live server — the settings DB is the source of truth. Fail
  // loudly before collecting inputs; there is no silent env fallback.
  if (!local && !client) {
    throw new Error("Not logged in. Run: lexa-cli login [--url <base>] [--key <lxk_...>], or use --local to write the env bootstrap.");
  }

  const appId = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "app-id");
    if (fromFlag) return fromFlag;
    const current = env.get("GITHUB_APP_ID") ?? "";
    if (current && !isTTY) return current;
    if (!isTTY) throw new Error("--app-id required on a non-TTY (or run on a terminal)");
    return yield* Effect.promise(() => prompt(`  GitHub App ID${current ? ` [${current}]` : ""}: `, current));
  });
  if (!/^\d+$/.test(appId)) throw new Error(`GITHUB_APP_ID must be a number, got "${appId}"`);

  const keyFile = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "pem-file");
    if (fromFlag) return fromFlag;
    const current = env.get("GITHUB_PRIVATE_KEY_FILE") ?? "";
    if (current && !isTTY) return current;
    if (!isTTY) throw new Error("--pem-file required on a non-TTY (or run on a terminal)");
    return yield* Effect.promise(() => prompt(`  Private key PEM path${current ? ` [${current}]` : ""}: `, current));
  });
  if (!existsSync(keyFile)) throw new Error(`PEM file not found: ${keyFile}`);
  if (!pemHeaderOk(keyFile)) throw new Error("PEM file has an unexpected header (expected -----BEGIN RSA PRIVATE KEY----- or PKCS#8)");

  const secret = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "webhook-secret");
    if (fromFlag) return fromFlag;
    const current = env.get("GITHUB_WEBHOOK_SECRET") ?? "";
    if (current && !isTTY) return current;
    if (!isTTY) throw new Error("--webhook-secret required on a non-TTY (or run on a terminal)");
    const generated = generateSecret();
    return yield* Effect.promise(() => prompt(`  Webhook secret [Enter to generate]: `, generated));
  });
  if (secret.length < 16) throw new Error(`GITHUB_WEBHOOK_SECRET too short (${secret.length} chars, min 16)`);

  // Remote (default): the settings DB is the source of truth — push the
  // values via the API and the server applies them immediately.
  if (!local && client) {
    const pemContent = readFileSync(keyFile, "utf-8");
    const saved = yield* client.updateGithubSettings({ appId, privateKey: pemContent, webhookSecret: secret });
    console.log("  Configured via API — applied immediately (no restart)");
    console.log("  This REPLACES the server's previous values (like saving in web Settings).");
    printServerState(saved);
    return;
  }

  // --local provisioning (env-file bootstrap): rewrite the env file, keep
  // every other key, own the GitHub block. The server imports these on its
  // next boot when its settings DB values are unset.
  const carried: string[] = [];
  try {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
        if (m && OWNED_KEYS.has(m[1]!)) continue;
        if (line.trim() !== "") carried.push(line);
      }
    }
  } catch { /* fresh file */ }
  writeFileSync(file, [...carried, `GITHUB_APP_ID=${appId}`, `GITHUB_PRIVATE_KEY_FILE=${keyFile}`, `GITHUB_WEBHOOK_SECRET=${secret}`, ""].join("\n"), { mode: 0o600 });
  console.log(`  Wrote ${file}`);
  console.log("");
  console.log("  These values are the first-boot BOOTSTRAP: the server imports");
  console.log("  them into its settings DB on the next boot ONLY when the key");
  console.log("  is still unset — they never overwrite values already set in");
  console.log("  web Settings (or by a logged-in github setup). Once the server");
  console.log("  has DB config, env-file writes are inert until a fresh deploy");
  console.log("  (deploy --clean or a new server).");
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Restart the server (bun run dev:full / docker compose up -d) to import.");
  console.log("    2. Point the GitHub App webhook at https://<host>/api/webhooks/github");
  console.log("    3. Verify with: lexa-cli github check <slug> <owner/repo>");
});

export const cmdGithubCheck = Effect.fn("LexaCli/cmdGithubCheck")(function* (client: LexaClient, flags: Record<string, string | boolean>, args: string[]) {
  const slug = args[0]! ?? "";
  const repo = args[1]! ?? "";
  if (!slug || !repo) {
    console.error("  Usage: lexa-cli github check <slug> <owner/repo>");
    process.exit(1);
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  const columns = yield* client.listColumns(slug);
  const open = columns.find((c) => c.githubState === "open");
  const closed = columns.find((c) => c.githubState === "closed");
  if (!open || !closed) {
    throw new Error(`project "${slug}" has no column mapped to github_state open/closed — map columns in Settings first`);
  }
  const swimlanes = yield* client.listSwimlanes(slug);
  if (swimlanes.length === 0) throw new Error(`project "${slug}" has no swimlanes`);

  console.log(`==> Round-trip: ${slug} → ${repo}`);
  const task = yield* client.createTask(slug, {
    columnId: open.id,
    swimlaneId: swimlanes[0]!.id,
    title: `GitHub sync check ${ts}`,
  });
  console.log(`  Task created: ${task.id}`);

  const linked = yield* client.linkGithubIssue(slug, task.id, repo);
  const issue = linked.githubs?.[0];
  if (!issue) throw new Error("link succeeded but response has no githubs — issue not created?");
  console.log(`  Issue created+linked: ${issue.url}`);

  const moved = yield* client.moveTask(slug, task.id, { columnId: closed.id, swimlaneId: swimlanes[0]!.id });
  const synced = moved.githubs?.find((g) => g.issueId === issue.issueId);
  console.log(`  Moved to "${closed.name}" (github_state=closed): ${synced?.syncedState ?? "?"}`);

  if (synced?.syncedState !== "closed") {
    console.error("  ✗ GitHub state did not reach 'closed' — check server logs (sync is best-effort).");
    process.exit(1);
  }
  console.log("  ✅ Lexa→GitHub leg passed (issue closed on move).");
  console.log("");
  console.log("  GitHub→Lexa leg (manual): close/reopen the issue in GitHub — the");
  console.log("  webhook moves the task to the mapped column (echo suppressed).");
  console.log(`  Cleanup: delete the test task + close/delete issue ${issue.issueNumber}.`);
});
