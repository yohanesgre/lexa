// cli/github.ts — server-API status/setup (mocked LexaClient; no network) and
// the round-trip orchestration (check, stubbed client). --local/--env-file are
// rejected with a hard error — GitHub sync is configured in the web app.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdGithubCheck, cmdGithubSetup } from "./github";
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

describe("cmdGithubSetup", () => {
  const goodPem = join(tmpdir(), "lexa-test.pem");
  beforeAll(() => writeFileSync(goodPem, "-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----\n", { mode: 0o600 }));

  function remoteClient(): LexaClient {
    return {
      updateGithubSettings: () => Effect.succeed({ appId: "123456", privateKeySet: true, webhookSecretSet: true, source: "db" }),
    } as unknown as LexaClient;
  }

  it("fails with the login error before collecting inputs, and requires --app-id/--webhook-secret on a non-TTY", async () => {
    await expect(Effect.runPromise(cmdGithubSetup({}, null)))
      .rejects.toThrow("Not logged in. Run: lx login");
    await expect(Effect.runPromise(cmdGithubSetup({ "pem-file": goodPem, "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("--app-id required on a non-TTY (or run on a terminal)");
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "123456", "pem-file": goodPem }, remoteClient())))
      .rejects.toThrow("--webhook-secret required on a non-TTY (or run on a terminal)");
  });

  it("rejects --local with the removal message, a PEM with an unexpected header, and a short webhook secret", async () => {
    await expect(Effect.runPromise(cmdGithubSetup(
      { local: true, "app-id": "123456", "pem-file": goodPem, "webhook-secret": "0123456789abcdef" },
      remoteClient(),
    ))).rejects.toThrow(REMOVED);

    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "-----BEGIN OPENSSH PRIVATE KEY-----\n");
    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "1", "pem-file": bad, "webhook-secret": "0123456789abcdef" }, remoteClient())))
      .rejects.toThrow("PEM file has an unexpected header");

    await expect(Effect.runPromise(cmdGithubSetup({ "app-id": "1", "pem-file": goodPem, "webhook-secret": "short" }, remoteClient())))
      .rejects.toThrow("GITHUB_WEBHOOK_SECRET too short (5 chars, min 16)");
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

  it("exits 1 when the sync did not reach closed", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => { throw new Error(`exit(${code})`); }) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(Effect.runPromise(cmdGithubCheck(stubClient("open"), {}, ["demo", "owner/repo"]))).rejects.toThrow(/exit\(1\)/);
    expect(outputOf(err)).toContain("✗ GitHub state did not reach 'closed'");
    exitSpy.mockRestore();
    err.mockRestore();
  });

  it("fails when no column maps to github_state open/closed, and when there are no swimlanes", async () => {
    const unmapped = {
      listColumns: () => Effect.succeed([{ id: "x", name: "X", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: null }]),
    } as unknown as LexaClient;
    await expect(Effect.runPromise(cmdGithubCheck(unmapped, {}, ["demo", "owner/repo"])))
      .rejects.toThrow("no column mapped to github_state open/closed");

    const noLanes = {
      listColumns: () => Effect.succeed([
        { id: "open", name: "Open", wipLimit: null, requiredFields: null, color: null, position: 0, githubState: "open" as const },
        { id: "closed", name: "Closed", wipLimit: null, requiredFields: null, color: null, position: 1, githubState: "closed" as const },
      ]),
      listSwimlanes: () => Effect.succeed([]),
    } as unknown as LexaClient;
    await expect(Effect.runPromise(cmdGithubCheck(noLanes, {}, ["demo", "owner/repo"])))
      .rejects.toThrow("no swimlanes");
  });
});
