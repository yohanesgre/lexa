// Miniflare Durable Object smoke (ADR-0003 §B.1). The other assistant tests
// exercise pure modules; this one proves the two things that only exist once
// the class is loaded by workerd:
//   1. `wrangler.jsonc`'s `durable_objects` binding + `new_sqlite_classes`
//      migration actually resolve `LexaAssistantAgent` (the class is exported
//      from the module graph, not merely declared).
//   2. The DO-side HMAC gate runs on a real WebSocket connect and SQLite
//      storage is available (`thread_meta` DDL + insert on the happy path).
// The bundle is built with the repo's existing esbuild (transitive via vite /
// wrangler); no new test dependency is declared here.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { signInternalAuth, type InternalAuthIdentity } from "./internal-auth";

const REPO_ROOT = new URL("../../", import.meta.url);
const MASTER_KEY = "do-smoke-master-key-0123456789";
const THREAD_KEY = "chat:smoke";

interface WranglerConfig {
  compatibility_date?: string;
  compatibility_flags?: string[];
  durable_objects?: { bindings?: Array<{ name?: string; class_name?: string }> };
  migrations?: Array<{ tag?: string; new_sqlite_classes?: string[] }>;
}

// wrangler.jsonc is JSONC: strip block and line comments before parsing. No
// JSON string value in this file contains `//` (verified: the only `*/` is the
// cron expression, inside a string, and it is not `//`).
function loadWranglerConfig(): WranglerConfig {
  const raw = readFileSync(new URL("wrangler.jsonc", REPO_ROOT), "utf8");
  const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return JSON.parse(withoutLineComments) as WranglerConfig;
}

const config = loadWranglerConfig();
const binding = config.durable_objects?.bindings?.find((b) => b.name === "ASSISTANT_AGENT");
const class_name = binding?.class_name ?? "";
const sqliteMigration = config.migrations?.find((m) => m.tag === "v1");
const useSQLite = sqliteMigration?.new_sqlite_classes?.includes(class_name) ?? false;

// The wrapper stands in for `server/workers-entry.ts`'s WS gate: get the
// thread-named DO and forward. Only the DO class + its imports are bundled —
// the Worker entry pulls the whole app and is exercised by the workers build.
const ENTRY = `
import { LexaAssistantAgent } from "./server/assistant/agent";
export { LexaAssistantAgent };
export default {
  async fetch(request, env) {
    const ns = env.ASSISTANT_AGENT;
    const stub = ns.get(ns.idFromName(${JSON.stringify(THREAD_KEY)}));
    return stub.fetch(request);
  },
};
`;

let mf: Miniflare | undefined;

interface Connection {
  status: number;
  closed: { code: number; reason: string } | null;
  readyState: () => number;
}

async function dispatchWebSocket(headers: Record<string, string>): Promise<Connection> {
  const res = await mf!.dispatchFetch("http://assistant-smoke/", {
    headers: { Upgrade: "websocket", ...headers },
  });
  const sock = res.webSocket;
  const connection: Connection = { status: res.status, closed: null, readyState: () => 3 };
  if (!sock) return connection;
  sock.accept();
  connection.readyState = () => sock.readyState;
  sock.addEventListener("close", (event) => {
    connection.closed = { code: event.code, reason: event.reason };
  });
  return connection;
}

// The first DO start plus the async HMAC verify can push the server's close
// frame well past a second (observed >1.5s under vitest); poll instead of
// guessing a single delay.
async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe("LexaAssistantAgent Durable Object smoke", () => {
  beforeAll(async () => {
    const bundled = await build({
      stdin: { contents: ENTRY, resolveDir: REPO_ROOT.pathname, loader: "ts" },
      bundle: true,
      format: "esm",
      platform: "browser",
      conditions: ["workerd", "worker", "browser", "import", "module"],
      external: ["node:*", "cloudflare:*", "path", "fs", "crypto", "util", "stream", "buffer", "os", "events"],
      write: false,
      logLevel: "silent",
    });
    const script = bundled.outputFiles[0]!.text;
    mf = new Miniflare(
      await convertV4MiniflareOptions({
        workers: [
          {
            name: "assistant-do-smoke",
            modules: true,
            script,
            compatibilityDate: config.compatibility_date ?? "2026-08-01",
            compatibilityFlags: config.compatibility_flags ?? [],
            durableObjects: { ASSISTANT_AGENT: { className: class_name, useSQLite } },
            bindings: { LXK_SECRETS_MASTER_KEY: MASTER_KEY },
          },
        ],
      })
    );
  }, 120_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it("wrangler.jsonc binds ASSISTANT_AGENT to LexaAssistantAgent with a v1 new_sqlite_classes migration", () => {
    expect(binding).toEqual({ name: "ASSISTANT_AGENT", class_name: "LexaAssistantAgent" });
    expect(sqliteMigration).toEqual({ tag: "v1", new_sqlite_classes: ["LexaAssistantAgent"] });
    expect(useSQLite).toBe(true);
  });

  it("rejects an unsigned websocket with 1008", async () => {
    // Warm the isolate with a signed connect first so the unsigned negative
    // case does not race the cold DO start; the close frame is then dispatched
    // deterministically and can be hard-asserted. The timing-free unit
    // assertion of the same rule lives in agent-gate.test.ts.
    const warmIdentity: InternalAuthIdentity = {
      actorUserId: "user-warm",
      projectId: "proj-1",
      threadKey: THREAD_KEY,
    };
    const warm = await dispatchWebSocket({
      "X-Lexa-Actor-UserId": warmIdentity.actorUserId,
      "X-Lexa-Project-Id": warmIdentity.projectId,
      "X-Lexa-Thread-Key": warmIdentity.threadKey,
      "X-Lexa-Internal": await signInternalAuth(MASTER_KEY, warmIdentity),
    });
    expect(warm.status).toBe(101);

    const connection = await dispatchWebSocket({});
    expect(connection.status).toBe(101);
    const closed = await waitUntil(() => connection.closed !== null, 20_000);
    expect(closed).toBe(true);
    expect(connection.closed?.code).toBe(1008);
  }, 60_000);

  it("keeps a correctly signed websocket open and writes thread_meta in SQLite", async () => {
    const identity: InternalAuthIdentity = { actorUserId: "user-1", projectId: "proj-1", threadKey: THREAD_KEY };
    const connection = await dispatchWebSocket({
      "X-Lexa-Actor-UserId": identity.actorUserId,
      "X-Lexa-Project-Id": identity.projectId,
      "X-Lexa-Thread-Key": identity.threadKey,
      "X-Lexa-Internal": await signInternalAuth(MASTER_KEY, identity),
    });
    expect(connection.status).toBe(101);
    // onConnect ran verifyConnection → ensureThreadMetaTable → pinThreadMeta
    // before super.onConnect; a SQLite failure would have thrown (1011/runtime
    // error) and a bad signature would close 1008.
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connection.closed).toBeNull();
    expect(connection.readyState()).toBe(1);
  }, 30_000);
});
