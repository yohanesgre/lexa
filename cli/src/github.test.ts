// cli/github.ts — env-file validation (status), interactive rewrite (setup),
// and the round-trip orchestration (check). Status/setup run against tmp env
// files (non-TTY, flag-driven); check runs with a stubbed LexaClient so no
// network is touched.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdGithubCheck, cmdGithubSetup, cmdGithubStatus } from "./github";
import type { LexaClient } from "./api";
import type { TaskInfo } from "./api";

let dir = "";
let envFile = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-github-test-"));
  envFile = join(dir, ".env");
  if (!existsSync(realPem)) writeFileSync(realPem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n", { mode: 0o600 });
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeEnv(content: string): void {
  writeFileSync(envFile, content, { mode: 0o600 });
}

// The status check verifies the key file exists on disk — use a real file.
const realPem = join(tmpdir(), "lexa-status-key.pem");

function completeEnv(): string {
  return [
    "GITHUB_APP_ID=123456",
    `GITHUB_PRIVATE_KEY_FILE=${realPem}`,
    "GITHUB_WEBHOOK_SECRET=0123456789abcdef",
  ].join("\n");
}

function outputOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]!)).join("\n");
}

const COMPLETE_ENV = [
  "GITHUB_APP_ID=123456",
  "GITHUB_PRIVATE_KEY_FILE=/tmp/key.pem",
  "GITHUB_WEBHOOK_SECRET=0123456789abcdef",
].join("\n");

describe("cmdGithubStatus", () => {
  it("reports a complete config with all ✅ rows", async () => {
    writeEnv(completeEnv());
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }));
    const out = outputOf(log);
    expect(out).toContain("✅ GITHUB_APP_ID — 123456");
    expect(out).toContain(`✅ GITHUB_PRIVATE_KEY_FILE — ${realPem}`);
    expect(out).toContain("✅ GITHUB_WEBHOOK_SECRET — 16 chars");
    expect(out).toContain("Config looks complete");
    log.mockRestore();
  });

  it("flags a missing GITHUB_APP_ID and counts missing vars", async () => {
    writeEnv("GITHUB_WEBHOOK_SECRET=0123456789abcdef\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }));
    const out = outputOf(log);
    expect(out).toContain("❌ GITHUB_APP_ID — missing");
    expect(out).toContain("2 var(s) missing or invalid");
    log.mockRestore();
  });

  it("flags a key file that does not exist on disk", async () => {
    writeEnv("GITHUB_APP_ID=1\nGITHUB_PRIVATE_KEY_FILE=/nope/missing.pem\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }));
    expect(outputOf(log)).toContain("file not found: /nope/missing.pem");
    log.mockRestore();
  });

  it("flags an inline PEM with a bad header as invalid", async () => {
    writeEnv("GITHUB_APP_ID=1\nGITHUB_PRIVATE_KEY=not-a-pem\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }));
    expect(outputOf(log)).toContain("invalid PEM");
    log.mockRestore();
  });

  it("flags a webhook secret shorter than 16 chars", async () => {
    writeEnv("GITHUB_APP_ID=1\nGITHUB_PRIVATE_KEY_FILE=/tmp/key.pem\nGITHUB_WEBHOOK_SECRET=short\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }));
    expect(outputOf(log)).toContain("❌ GITHUB_WEBHOOK_SECRET — 5 chars");
    log.mockRestore();
  });

  it("defaults to .env without --env-file", async () => {
    const cwd = process.cwd();
    writeEnv(completeEnv());
    process.chdir(dir);
    try {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await Effect.runPromise(cmdGithubStatus({ local: true }));
      expect(outputOf(log)).toContain("==> Reading .env");
      log.mockRestore();
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("cmdGithubStatus (default: remote)", () => {
  it("prints the effective server state from a mocked client", async () => {
    const client = {
      getGithubSettings: () => Effect.succeed({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" }),
    } as unknown as LexaClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({}, client));
    const out = outputOf(log);
    expect(out).toContain("==> GitHub sync — server state");
    expect(out).toContain("✅ GitHub App ID — 123456");
    expect(out).toContain("✅ Private key — set (server DB)");
    expect(out).toContain("✅ Webhook secret — set (server DB)");
    expect(out).toContain("source: db — the server DB is the source of truth");
    expect(out).toContain("Changes apply immediately (no restart).");
    log.mockRestore();
  });

  it("flags missing pieces from the server", async () => {
    const client = {
      getGithubSettings: () => Effect.succeed({ appId: "", privateKeySet: false, webhookSecretSet: false, source: "db" }),
    } as unknown as LexaClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({}, client));
    const out = outputOf(log);
    expect(out).toContain("❌ GitHub App ID — missing");
    expect(out).toContain("fix with: lexa-cli github setup");
    log.mockRestore();
  });

  it("errors clearly without a client (no creds), pointing at --local", async () => {
    await expect(Effect.runPromise(cmdGithubStatus({}, null)))
      .rejects.toThrow("Not logged in. Run: lexa-cli login [--url <base>] [--key <lxk_...>], or use --local to check the env file.");
  });

  it("--local validates the env file even with a client present (client ignored)", async () => {
    writeEnv(completeEnv());
    const client = {
      getGithubSettings: () => { throw new Error("must not be called"); },
    } as unknown as LexaClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubStatus({ local: true, "env-file": envFile }, client));
    expect(outputOf(log)).toContain("✅ GITHUB_APP_ID — 123456");
    expect(outputOf(log)).toContain("first-boot BOOTSTRAP");
    log.mockRestore();
  });
});

describe("cmdGithubSetup", () => {
  const goodPem = join(tmpdir(), "lexa-test.pem");
  beforeAll(() => writeFileSync(goodPem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 }));

  it("writes the GitHub block from flags, preserving unrelated keys and chmod 600", async () => {
    writeEnv("LXK_API_KEY=keepme\nGITHUB_APP_ID=999\nGITHUB_PRIVATE_KEY=stale-inline\n");
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }));
    const raw = readFileSync(envFile, "utf-8");
    expect(raw).toContain("LXK_API_KEY=keepme");
    expect(raw).toContain("GITHUB_APP_ID=123456");
    expect(raw).toContain(`GITHUB_PRIVATE_KEY_FILE=${goodPem}`);
    expect(raw).toContain("GITHUB_WEBHOOK_SECRET=0123456789abcdef");
    expect(raw).not.toContain("GITHUB_PRIVATE_KEY=stale-inline"); // owned key dropped
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    expect(outputOf(log)).toContain(`Wrote ${envFile}`);
    log.mockRestore();
  });

  it("reuses existing env values on a non-TTY when no flags are given", async () => {
    writeEnv(`GITHUB_APP_ID=456\nGITHUB_PRIVATE_KEY_FILE=${goodPem}\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n`);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile }));
    const raw = readFileSync(envFile, "utf-8");
    expect(raw).toContain("GITHUB_APP_ID=456");
    expect(raw).toContain(`GITHUB_PRIVATE_KEY_FILE=${goodPem}`);
    log.mockRestore();
  });

  it("requires --app-id on a non-TTY when the env file has none", async () => {
    writeEnv("GITHUB_WEBHOOK_SECRET=0123456789abcdef\n");
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "pem-file": goodPem, "webhook-secret": "0123456789abcdef" })))
      .rejects.toThrow("--app-id required on a non-TTY (or run on a terminal)");
  });

  it("rejects a non-numeric app id", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "abc", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" })))
      .rejects.toThrow("GITHUB_APP_ID must be a number, got \"abc\"");
  });

  it("rejects a missing PEM file", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "1", "pem-file": join(dir, "missing.pem"), "webhook-secret": "0123456789abcdef" })))
      .rejects.toThrow("PEM file not found");
  });

  it("rejects a PEM with an unexpected header", async () => {
    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "1", "pem-file": bad, "webhook-secret": "0123456789abcdef" })))
      .rejects.toThrow("PEM file has an unexpected header");
  });

  it("rejects a webhook secret shorter than 16 chars", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "1", "pem-file": goodPem, "webhook-secret": "short" })))
      .rejects.toThrow("GITHUB_WEBHOOK_SECRET too short (5 chars, min 16)");
  });

  it("requires --webhook-secret on a non-TTY when the env file has none", async () => {
    writeEnv(`GITHUB_APP_ID=456\nGITHUB_PRIVATE_KEY_FILE=${goodPem}\n`);
    await expect(Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile })))
      .rejects.toThrow("--webhook-secret required on a non-TTY (or run on a terminal)");
  });

  describe("default mode (remote API, client provided)", () => {
    it("calls updateGithubSettings with the PEM content and prints applied-immediately", async () => {
      let sent: unknown = null;
      const client = {
        updateGithubSettings: (input: unknown) => {
          sent = input;
          return Effect.succeed({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" });
        },
      } as unknown as LexaClient;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await Effect.runPromise(cmdGithubSetup({ "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, client));
      expect(sent).toEqual({
        appId: "123456",
        privateKey: "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n",
        webhookSecret: "0123456789abcdef",
      });
      const out = outputOf(log);
      expect(out).toContain("Configured via API — applied immediately (no restart)");
      expect(out).toContain("This REPLACES the server's previous values (like saving in web Settings).");
      expect(out).toContain("✅ GitHub App ID — 123456");
      log.mockRestore();
    });

    it("errors clearly without a client (no creds), pointing at --local", async () => {
      await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, null)))
        .rejects.toThrow("Not logged in. Run: lexa-cli login [--url <base>] [--key <lxk_...>], or use --local to write the env bootstrap.");
    });

    it("fails with the login error before collecting inputs when not logged in", async () => {
      await expect(Effect.runPromise(cmdGithubSetup({}, null)))
        .rejects.toThrow("or use --local to write the env bootstrap");
    });

    it("does not touch the env file in remote mode", async () => {
      const client = {
        updateGithubSettings: () => Effect.succeed({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" }),
      } as unknown as LexaClient;
      await Effect.runPromise(cmdGithubSetup({ "env-file": envFile, "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, client));
      expect(existsSync(envFile)).toBe(false);
    });

    it("reuses env-file defaults for inputs on a non-TTY", async () => {
      writeEnv("GITHUB_APP_ID=456\nGITHUB_WEBHOOK_SECRET=0123456789abcdef\n");
      let sent: unknown = null;
      const client = {
        updateGithubSettings: (input: unknown) => {
          sent = input;
          return Effect.succeed({ appId: "456", privateKeySet: true, webhookSecretSet: true, source: "db" });
        },
      } as unknown as LexaClient;
      await Effect.runPromise(cmdGithubSetup({ "env-file": envFile, "pem-file": goodPem }, client));
      expect(sent).toMatchObject({ appId: "456", webhookSecret: "0123456789abcdef" });
    });

    it("still validates inputs the same way as local mode", async () => {
      const client = {
        updateGithubSettings: () => Effect.succeed({ appId: "1", privateKeySet: true, webhookSecretSet: true, source: "db" }),
      } as unknown as LexaClient;
      await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "abc", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, client)))
        .rejects.toThrow("GITHUB_APP_ID must be a number");
    });
  });

  describe("provisioning mode (--local forces env-file even with a client)", () => {
    it("writes the env file and prints the bootstrap note", async () => {
      writeEnv("LXK_API_KEY=keepme\n");
      const client = {
        updateGithubSettings: () => { throw new Error("must not be called"); },
      } as unknown as LexaClient;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      await Effect.runPromise(cmdGithubSetup({ local: true, "env-file": envFile, "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, client));
      const raw = readFileSync(envFile, "utf-8");
      expect(raw).toContain("LXK_API_KEY=keepme");
      expect(raw).toContain("GITHUB_APP_ID=123456");
      expect(raw).toContain(`GITHUB_PRIVATE_KEY_FILE=${goodPem}`);
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
      const out = outputOf(log);
      expect(out).toContain(`Wrote ${envFile}`);
      expect(out).toContain("first-boot BOOTSTRAP");
      expect(out).toContain("server imports");
      expect(out).toContain("never overwrite values already set");
      expect(out).toContain("inert until a fresh deploy");
      log.mockRestore();
    });
  });
});

describe("cmdGithubCheck", () => {
  function stubClient(moveSyncedState: "open" | "closed" | null): LexaClient {
    const base = {
      id: "t1",
      key: "EG-1",
      title: "GitHub sync check",
      priority: null,
      type: null,
      columnId: "open",
      swimlaneId: "sl",
      assignees: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    } satisfies TaskInfo;
    const columns = [
      { id: "open", name: "Open", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: "open" as const },
      { id: "closed", name: "Closed", wipLimit: null, requiredFields: null, color: null, position: 1, githubState: "closed" as const },
    ];
    return {
      listColumns: () => Effect.succeed(columns),
      listSwimlanes: () => Effect.succeed([{ id: "sl", name: "S", position: 0 }]),
      createTask: () => Effect.succeed(base),
      linkGithubIssue: () => Effect.succeed({ ...base, githubs: [{ issueId: "i1", issueNumber: 5, repo: "o/r", syncedState: "open", url: "https://github.com/o/r/issues/5", outOfSync: false }] }),
      moveTask: () => Effect.succeed({ ...base, githubs: [{ issueId: "i1", issueNumber: 5, repo: "o/r", syncedState: moveSyncedState, url: "https://github.com/o/r/issues/5", outOfSync: false }] }),
    } as unknown as LexaClient;
  }

  it("prints usage and exits 1 when args are missing", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(Effect.runPromise(cmdGithubCheck(stubClient("closed"), {}, []))).rejects.toThrow(/exit\(1\)/);
    expect(outputOf(err)).toContain("Usage: lexa-cli github check <slug> <owner/repo>");
    exitSpy.mockRestore();
    err.mockRestore();
  });

  it("passes the round-trip when the move reaches github_state closed", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await Effect.runPromise(cmdGithubCheck(stubClient("closed"), {}, ["demo", "owner/repo"]));
    const out = outputOf(log);
    expect(out).toContain("Task created: t1");
    expect(out).toContain("Issue created+linked: https://github.com/o/r/issues/5");
    expect(out).toContain("Lexa→GitHub leg passed");
    log.mockRestore();
  });

  it("exits 1 when the sync did not reach closed", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(Effect.runPromise(cmdGithubCheck(stubClient("open"), {}, ["demo", "owner/repo"]))).rejects.toThrow(/exit\(1\)/);
    expect(outputOf(err)).toContain("✗ GitHub state did not reach 'closed'");
    exitSpy.mockRestore();
    err.mockRestore();
  });

  it("fails when no column maps to github_state open/closed", async () => {
    const client = {
      listColumns: () => Effect.succeed([{ id: "x", name: "X", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: null }]),
    } as unknown as LexaClient;
    await expect(Effect.runPromise(cmdGithubCheck(client, {}, ["demo", "owner/repo"])))
      .rejects.toThrow("no column mapped to github_state open/closed");
  });

  it("fails when the project has no swimlanes", async () => {
    const client = {
      listColumns: () => Effect.succeed([
        { id: "open", name: "Open", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: "open" as const },
        { id: "closed", name: "Closed", wipLimit: null, requiredFields: null, color: null, position: 1, githubState: "closed" as const },
      ]),
      listSwimlanes: () => Effect.succeed([]),
    } as unknown as LexaClient;
    await expect(Effect.runPromise(cmdGithubCheck(client, {}, ["demo", "owner/repo"])))
      .rejects.toThrow("no swimlanes");
  });
});
