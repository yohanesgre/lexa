// lexa-cli github — validate, configure, and round-trip the GitHub sync
// integration. Config lives in the server env (GITHUB_APP_ID,
// GITHUB_PRIVATE_KEY[_FILE], GITHUB_WEBHOOK_SECRET); the server reads it at
// boot, so changes require a restart. status validates the env file locally;
// setup rewrites it interactively; check drives the Lexa→GitHub leg of the
// RELEASE.md acceptance round-trip against a live server.
import { Effect } from "effect";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { LexaClient } from "./api";

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
      if (m) out.set(m[1], m[2]);
    }
  } catch { /* unreadable file = empty map */ }
  return out;
}

function pemHeaderOk(pemPath: string): boolean {
  try {
    const first = readFileSync(pemPath, "utf-8").split("\n")[0].trim();
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
    console.log("  Config looks complete. Changes take effect on server restart —");
    console.log("  then run `lexa-cli github check <slug> <owner/repo>` for the round-trip.");
  } else {
    console.log(`  ${missing} var(s) missing or invalid — fix with:`);
    console.log("    lexa-cli github setup [--env-file <path>]");
    console.log("  Full manual guide: docs/GITHUB_SETUP.md");
  }
}

export const cmdGithubStatus = Effect.fn("LexaCli/cmdGithubStatus")(function* (flags: Record<string, string | boolean>) {
  const file = envFileFor(flags);
  console.log(`==> Reading ${file}`);
  yield* Effect.sync(() => printStatus(readEnv(file)));
});

export const cmdGithubSetup = Effect.fn("LexaCli/cmdGithubSetup")(function* (flags: Record<string, string | boolean>) {
  const file = envFileFor(flags);
  const env = readEnv(file);
  const isTTY = process.stdin.isTTY === true;

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

  // Rewrite the env file: keep every other key, own the GitHub block.
  const carried: string[] = [];
  try {
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf-8").split("\n")) {
        const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line.trim());
        if (m && OWNED_KEYS.has(m[1])) continue;
        if (line.trim() !== "") carried.push(line);
      }
    }
  } catch { /* fresh file */ }
  writeFileSync(file, [...carried, `GITHUB_APP_ID=${appId}`, `GITHUB_PRIVATE_KEY_FILE=${keyFile}`, `GITHUB_WEBHOOK_SECRET=${secret}`, ""].join("\n"), { mode: 0o600 });
  console.log(`  Wrote ${file}`);
  console.log("");
  console.log("  Next steps:");
  console.log("    1. Restart the server (bun run dev:full / docker compose up -d).");
  console.log("    2. Point the GitHub App webhook at https://<host>/api/webhooks/github");
  console.log("       (must bypass Cloudflare Access — docs/GITHUB_SETUP.md §5).");
  console.log("    3. Verify with: lexa-cli github check <slug> <owner/repo>");
});

export const cmdGithubCheck = Effect.fn("LexaCli/cmdGithubCheck")(function* (client: LexaClient, flags: Record<string, string | boolean>, args: string[]) {
  const slug = args[0] ?? "";
  const repo = args[1] ?? "";
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
    swimlaneId: swimlanes[0].id,
    title: `GitHub sync check ${ts}`,
  });
  console.log(`  Task created: ${task.id}`);

  const linked = yield* client.linkGithubIssue(slug, task.id, repo);
  const issue = linked.githubs?.[0];
  if (!issue) throw new Error("link succeeded but response has no githubs — issue not created?");
  console.log(`  Issue created+linked: ${issue.url}`);

  const moved = yield* client.moveTask(slug, task.id, { columnId: closed.id, swimlaneId: swimlanes[0].id });
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
