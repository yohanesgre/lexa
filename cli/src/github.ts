// lx github — validate, configure, and round-trip the GitHub sync
// integration. GitHub config lives in the server's settings DB, managed in
// the web app (Settings → Workspace → Integrations → GitHub Sync); status and
// setup talk to the live server via the API (login required). check drives
// the Lexa→GitHub leg of the RELEASE.md acceptance round-trip against a live
// server.
import { Effect } from "effect";
import { existsSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LexaClient, type GithubSettingsInfo } from "./api";

const ENV_FLAGS_REMOVED =
  "--local/--env-file were removed — GitHub sync is configured in the web app (Settings → Workspace → Integrations → GitHub Sync). Run: lx github setup";

export function envFlagsRemoved(flags: Record<string, string | boolean>): boolean {
  return flags.local === true || flags["env-file"] !== undefined;
}

function flagStr(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  return typeof v === "string" ? v : "";
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

// The server's effective settings (from GET/PUT /api/settings/github). The
// DB is the source of truth, so "set" means the server has a usable value.
function printServerState(s: GithubSettingsInfo): void {
  console.log(`  ${s.appId !== "" ? "✅" : "❌"} GitHub App ID — ${s.appId || "missing"}`);
  console.log(`  ${s.privateKeySet ? "✅" : "❌"} Private key — ${s.privateKeySet ? "set (server DB)" : "missing"}`);
  console.log(`  ${s.webhookSecretSet ? "✅" : "❌"} Webhook secret — ${s.webhookSecretSet ? "set (server DB)" : "missing"}`);
  console.log(`  Config source: ${s.source} — the server DB is the source of truth.`);
}

export const cmdGithubStatus = Effect.fn("LexaCli/cmdGithubStatus")(function* (flags: Record<string, string | boolean>, client: LexaClient | null = null) {
  if (envFlagsRemoved(flags)) throw new Error(ENV_FLAGS_REMOVED);
  if (!client) throw new Error("Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]");
  const s = yield* client.getGithubSettings();
  console.log("==> GitHub sync — server state (GET /api/settings/github)");
  printServerState(s);
  if (!s.appId || !s.privateKeySet || !s.webhookSecretSet) {
    console.log("  Missing pieces — fix with: lx github setup");
  } else {
    console.log("  Config complete. Run `lx github check <slug> <owner/repo>`");
    console.log("  for the round-trip. Changes apply immediately (no restart).");
  }
});

export const cmdGithubSetup = Effect.fn("LexaCli/cmdGithubSetup")(function* (flags: Record<string, string | boolean>, client: LexaClient | null = null) {
  if (envFlagsRemoved(flags)) throw new Error(ENV_FLAGS_REMOVED);
  const isTTY = process.stdin.isTTY === true;
  // The settings DB is the source of truth. Fail loudly before collecting
  // inputs; there is no env fallback.
  if (!client) {
    throw new Error("Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]");
  }

  const appId = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "app-id");
    if (fromFlag) return fromFlag;
    if (!isTTY) throw new Error("--app-id required on a non-TTY (or run on a terminal)");
    return yield* Effect.promise(() => prompt("  GitHub App ID: "));
  });
  if (!/^\d+$/.test(appId)) throw new Error(`GITHUB_APP_ID must be a number, got "${appId}"`);

  const keyFile = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "pem-file");
    if (fromFlag) return fromFlag;
    if (!isTTY) throw new Error("--pem-file required on a non-TTY (or run on a terminal)");
    return yield* Effect.promise(() => prompt("  Private key PEM path: "));
  });
  if (!existsSync(keyFile)) throw new Error(`PEM file not found: ${keyFile}`);
  if (!pemHeaderOk(keyFile)) throw new Error("PEM file has an unexpected header (expected -----BEGIN RSA PRIVATE KEY----- or PKCS#8)");

  const secret = yield* Effect.gen(function* () {
    const fromFlag = flagStr(flags, "webhook-secret");
    if (fromFlag) return fromFlag;
    if (!isTTY) throw new Error("--webhook-secret required on a non-TTY (or run on a terminal)");
    const generated = generateSecret();
    return yield* Effect.promise(() => prompt("  Webhook secret [Enter to generate]: ", generated));
  });
  if (secret.length < 16) throw new Error(`GITHUB_WEBHOOK_SECRET too short (${secret.length} chars, min 16)`);

  const pemContent = readFileSync(keyFile, "utf-8");
  const saved = yield* client.updateGithubSettings({ appId, privateKey: pemContent, webhookSecret: secret });
  console.log("  Configured via API — applied immediately (no restart)");
  console.log("  This REPLACES the server's previous values (like saving in web Settings).");
  printServerState(saved);
});

export const cmdGithubCheck = Effect.fn("LexaCli/cmdGithubCheck")(function* (client: LexaClient, flags: Record<string, string | boolean>, args: string[]) {
  const slug = args[0]! ?? "";
  const repo = args[1]! ?? "";
  if (!slug || !repo) {
    console.error("  Usage: lx github check <slug> <owner/repo>");
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
