import { describe, expect, it, beforeEach, vi } from "vitest";
import { Database } from "bun:sqlite";
import { createBunSqliteDriver } from "../db/drivers/bun-sqlite";
import { buildMcpTools, type McpToolset } from "./mcp";
import { discoverMcpDescriptors, executeMcpTool, invalidateMcpDescriptorCache } from "./mcp-descriptors";

const DDL = [
  "CREATE TABLE assistant_mcp_servers (id TEXT PRIMARY KEY, transport_type TEXT, url TEXT, enabled INTEGER, secret_ref TEXT)",
  "CREATE TABLE assistant_mcp_project_servers (server_id TEXT, project_id TEXT, enabled INTEGER)",
  "CREATE TABLE assistant_mcp_secrets (server_id TEXT, ciphertext TEXT, iv TEXT, key_id TEXT)",
];

function fresh() {
  const db = new Database(":memory:");
  for (const sql of DDL) db.exec(sql);
  db.exec("INSERT INTO assistant_mcp_servers (id, transport_type, url, enabled) VALUES ('srv', 'http', 'https://mcp.test', 1)");
  db.exec("INSERT INTO assistant_mcp_project_servers (server_id, project_id, enabled) VALUES ('srv', 'p1', 1)");
  return createBunSqliteDriver(db);
}

function fakeBuild(tools: unknown[], closed = { value: false }): typeof buildMcpTools {
  return (async () => ({
    tools,
    close: async () => {
      closed.value = true;
    },
  })) as unknown as typeof buildMcpTools;
}

const ENV = {} as never;

describe("discoverMcpDescriptors", () => {
  let driver: ReturnType<typeof fresh>;
  beforeEach(() => {
    driver = fresh();
    invalidateMcpDescriptorCache();
  });

  it("fails open empty without a runtime env", async () => {
    const build = vi.fn(fakeBuild([]));
    const tools = await discoverMcpDescriptors({ driver, env: null, allowlist: null, projectId: "p1", buildTools: build });
    expect(tools).toEqual([]);
    expect(build).not.toHaveBeenCalled();
  });

  it("returns read-only descriptors and closes the toolset", async () => {
    const closed = { value: false };
    const build = fakeBuild(
      [
        { name: "mcp__srv__read", description: "reads", inputSchema: { type: "object", properties: { q: { type: "string" } } } },
        { name: "mcp__srv__write", description: "writes", inputSchema: { type: "object" } },
      ],
      closed
    );
    const tools = await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build });
    expect(tools.map((t) => t.name)).toEqual(["mcp__srv__read", "mcp__srv__write"]);
    expect(tools[0]?.inputSchema).toEqual({ type: "object", properties: { q: { type: "string" } } });
    expect(closed.value).toBe(true);
  });

  it("caches within the TTL and refreshes after it (or on invalidation)", async () => {
    let calls = 0;
    const build = (async () => {
      calls += 1;
      return { tools: [{ name: "mcp__srv__read", description: "d", inputSchema: { type: "object" } }], close: async () => {} };
    }) as unknown as typeof buildMcpTools;

    let now = 1_000;
    const first = await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build, now: () => now });
    expect(first).toHaveLength(1);
    expect(calls).toBe(1);

    now += 30_000;
    await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build, now: () => now });
    expect(calls).toBe(1);

    now += 40_000; // past the 60s TTL
    await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build, now: () => now });
    expect(calls).toBe(2);

    invalidateMcpDescriptorCache("p1");
    await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build, now: () => now });
    expect(calls).toBe(3);
  });

  it("fails open empty when discovery throws", async () => {
    const build = (async () => {
      throw new Error("connect failed");
    }) as unknown as typeof buildMcpTools;
    const tools = await discoverMcpDescriptors({ driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build });
    expect(tools).toEqual([]);
  });
});

describe("executeMcpTool", () => {
  let driver: ReturnType<typeof fresh>;
  beforeEach(() => {
    driver = fresh();
  });

  it("dispatches a read-only prefixed tool and returns its result", async () => {
    const build = fakeBuild([{ name: "mcp__srv__read", execute: async (args: unknown) => ({ echoed: args }) }]);
    const result = await executeMcpTool(
      { driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build },
      "mcp__srv__read",
      { q: "hi" }
    );
    expect(result).toEqual({ ok: true, result: { echoed: { q: "hi" } } });
  });

  it("default-denies a tool the read-only bridge did not expose", async () => {
    const build = fakeBuild([{ name: "mcp__srv__read", execute: async () => ({}) }]);
    const result = await executeMcpTool(
      { driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build },
      "mcp__srv__write",
      {}
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown MCP tool");
  });

  it("returns a typed failure when the remote call throws", async () => {
    const build = fakeBuild([
      { name: "mcp__srv__read", execute: async () => { throw new Error("MCP tool call failed — remote error details are not forwarded"); } },
    ]);
    const result = await executeMcpTool(
      { driver, env: ENV, allowlist: null, projectId: "p1", buildTools: build },
      "mcp__srv__read",
      {}
    );
    expect(result).toMatchObject({ ok: false, error: "MCP tool call failed — remote error details are not forwarded" });
  });
});
