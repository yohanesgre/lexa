// cli/github.ts — server-API status/setup (mocked LexaClient; no network) and
// the round-trip orchestration (check, stubbed client). --local/--env-file are
// rejected with a hard error — GitHub sync is configured in the web app.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdGithubCheck, cmdGithubSetup, cmdGithubStatus } from "./github";
import type { LexaClient } from "./api";
import type { TaskInfo } from "./api";

const REMOVED =
  "--local/--env-file were removed — GitHub sync is configured in the web app (Settings → Workspace → Integrations → GitHub Sync). Run: lx github setup";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lexa-github-test-"));
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function outputOf(spy: { mock: { calls: unknown[][] } }): string {
  return spy.mock.calls.map((c: unknown[]) => String(c[0]!)).join("\n");
}

describe("cmdGithubStatus", () => {
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
    expect(out).toContain("fix with: lx github setup");
    log.mockRestore();
  });

  it("errors clearly without a client (no creds)", async () => {
    await expect(Effect.runPromise(cmdGithubStatus({}, null)))
      .rejects.toThrow("Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]");
  });

  it("rejects --local with the removal message even with a client present", async () => {
    const client = {
      getGithubSettings: () => { throw new Error("must not be called"); },
    } as unknown as LexaClient;
    await expect(Effect.runPromise(cmdGithubStatus({ local: true }, client))).rejects.toThrow(REMOVED);
  });

  it("rejects --env-file with the removal message", async () => {
    await expect(Effect.runPromise(cmdGithubStatus({ "env-file": join(dir, ".env") }, null))).rejects.toThrow(REMOVED);
  });
});

describe("cmdGithubSetup", () => {
  const goodPem = join(tmpdir(), "lexa-test.pem");
  beforeAll(() => writeFileSync(goodPem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 }));

  function remoteClient(): LexaClient {
    return {
      updateGithubSettings: () => Effect.succeed({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" }),
    } as unknown as LexaClient;
  }

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

  it("rejects --local with the removal message even with a client present", async () => {
    await expect(Effect.runPromise(cmdGithubSetup(
      { local: true, "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" },
      remoteClient(),
    ))).rejects.toThrow(REMOVED);
  });

  it("rejects --env-file with the removal message", async () => {
    await expect(Effect.runPromise(cmdGithubSetup(
      { "env-file": join(dir, ".env"), "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" },
      remoteClient(),
    ))).rejects.toThrow(REMOVED);
  });

  it("errors clearly without a client (no creds)", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, null)))
      .rejects.toThrow("Not logged in. Run: lx login [--url <base>] [--key <lxk_...>]");
  });

  it("fails with the login error before collecting inputs when not logged in", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({}, null)))
      .rejects.toThrow("Not logged in. Run: lx login");
  });

  it("requires --app-id on a non-TTY when no flag is given", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("--app-id required on a non-TTY (or run on a terminal)");
  });

  it("rejects a non-numeric app id", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "abc", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("GITHUB_APP_ID must be a number, got \"abc\"");
  });

  it("rejects a missing PEM file", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "1", "pem-file": join(dir, "missing.pem"), "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("PEM file not found");
  });

  it("rejects a PEM with an unexpected header", async () => {
    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "1", "pem-file": bad, "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("PEM file has an unexpected header");
  });

  it("rejects a webhook secret shorter than 16 chars", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "1", "pem-file": goodPem, "webhook-secret": "short" }, remoteClient())))
      .rejects.toThrow("GITHUB_WEBHOOK_SECRET too short (5 chars, min 16)");
  });

  it("requires --webhook-secret on a non-TTY when no flag is given", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "123456", "pem-file": goodPem }, remoteClient())))
      .rejects.toThrow("--webhook-secret required on a non-TTY (or run on a terminal)");
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
    expect(outputOf(err)).toContain("Usage: lx github check <slug> <owner/repo>");
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
