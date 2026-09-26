import { describe, expect, it, vi } from "vitest";
import type { StreamChunk } from "@tanstack/ai";
import { MAX_CHAT_TOOL_ROUNDS } from "./tools";
import type { McpServerRow } from "../repos/assistant-mcp.repo";
import type { StreamFrame } from "../../shared/assistant";
import {
  buildMcpTools,
  isReadOnlyMcpTool,
  mcpToolPrefix,
  MCP_TOOL_NAME_MAX,
  parsePrefixedMcpToolName,
  prefixedMcpToolName,
  sanitizeMcpServerId,
  validateMcpTransportUrl,
  type McpClientFactory,
  type McpClientHandle,
  type McpDiscoveredTool,
  type McpToolCallAudit,
} from "./mcp";
import { buildStream, type StreamRunContext } from "./build-stream";

const providerMock = vi.hoisted(() => ({ script: [] as Array<Record<string, unknown>> }));

vi.mock("./provider", () => ({
  streamChat: async function* () {
    for (const chunk of providerMock.script) yield chunk;
  },
  completeText: async () => {
    throw new Error("unexpected summarize call");
  },
  translateRunError: (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  clientFacingErrorMessage: (err: unknown) => (err instanceof Error ? err.message : "Assistant generation failed"),
}));

const ssrfMock = vi.hoisted(() => ({ block: false }));
vi.mock("./ssrf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ssrf")>();
  return {
    ...actual,
    validateUrl: async (raw: string) => {
      if (ssrfMock.block) throw new actual.UrlBlocked({ reason: "private or reserved addresses are blocked" });
      return new URL(raw);
    },
  };
});

// Locked fixture for the `tool.metadata.mcp` shape the read-only filter reads.
// If @tanstack/ai-mcp renames this block, this fixture fails and the filter
// must be updated in lockstep.
const MCP_TOOL_FIXTURE: McpDiscoveredTool = {
  name: "read_docs",
  description: "Read docs",
  inputSchema: { type: "object", properties: {} },
  metadata: {
    mcp: {
      serverToolName: "read_docs",
      title: "Read docs",
      annotations: { readOnlyHint: true, title: "Read docs" },
    },
  },
  execute: async () => "ok",
};

function row(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return {
    id: "fake",
    label: "Fake",
    transport_type: "http",
    url: "https://mcp.test/mcp",
    command: null,
    args: "[]",
    secret_ref: null,
    enabled: 1,
    created_at: "",
    updated_at: "",
    ...overrides,
  };
}

function handle(tools: McpDiscoveredTool[], onClose?: () => void): McpClientHandle {
  return { tools: async () => tools, close: async () => { onClose?.(); } };
}

function factory(handles: Record<string, McpClientHandle>): McpClientFactory {
  return {
    create: async (r) => {
      const h = handles[r.id];
      if (!h) throw new Error(`no fake for ${r.id}`);
      return h;
    },
  };
}

function tool(name: string, readOnly: boolean | undefined, execute?: McpDiscoveredTool["execute"]): McpDiscoveredTool {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    metadata: {
      mcp: {
        serverToolName: name,
        title: name,
        ...(readOnly !== undefined ? { annotations: { readOnlyHint: readOnly } } : {}),
      },
    },
    execute: execute ?? (async () => "ok"),
  };
}

async function drain(stream: ReadableStream<StreamFrame>): Promise<StreamFrame[]> {
  const out: StreamFrame[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function baseCtx(tools: unknown[], gatewayStream: (input: unknown) => AsyncIterable<StreamChunk>): StreamRunContext {
  return {
    keyId: "c1",
    idField: "chatId",
    threadId: "c1",
    registry: new Map(),
    config: { kind: "openai_compatible", baseUrl: "https://x.test", apiKey: "k", model: "m" },
    systemPrompts: [],
    history: [],
    userTs: "2026-09-27T00:00:00Z",
    getCitations: () => [],
    userContent: "hi",
    tools,
    toolRoundCap: MAX_CHAT_TOOL_ROUNDS,
    loadImageBase64: async () => null,
    imageMode: "inline",
    historySummary: () => null,
    historySummarizedCount: () => 0,
    persist: async () => {},
    onDone: async () => {},
    onFail: async () => {},
    onCancel: async () => {},
    gatewayStream,
  };
}

describe("mcp tool names", () => {
  it("sanitizes server ids to [a-z0-9_] and caps the segment", () => {
    expect(sanitizeMcpServerId("My Server!")).toBe("my_server");
    expect(sanitizeMcpServerId("")).toBe("server");
    expect(sanitizeMcpServerId("A".repeat(80)).length).toBeLessThanOrEqual(24);
  });

  it("prefixes and parses mcp__<serverId>__<tool>", () => {
    expect(mcpToolPrefix("jev")).toBe("mcp__jev__");
    expect(prefixedMcpToolName("jev", "search")).toBe("mcp__jev__search");
    expect(parsePrefixedMcpToolName("mcp__jev__search")).toEqual({ serverId: "jev", toolName: "search" });
    expect(parsePrefixedMcpToolName("search")).toBeNull();
  });

  it("caps the joined tool name at 64 chars, truncating the tool segment", () => {
    const name = prefixedMcpToolName("my_server", "x".repeat(200));
    expect(name.length).toBe(MCP_TOOL_NAME_MAX);
    expect(name.startsWith("mcp__my_server__")).toBe(true);
  });
});

describe("isReadOnlyMcpTool", () => {
  it("reads the locked metadata.mcp.annotations.readOnlyHint shape", () => {
    expect(isReadOnlyMcpTool(MCP_TOOL_FIXTURE)).toBe(true);
  });

  it("default-denies when the annotation is absent or false", () => {
    expect(isReadOnlyMcpTool({ name: "write" })).toBe(false);
    expect(isReadOnlyMcpTool({ name: "write", metadata: { mcp: { serverToolName: "write" } } })).toBe(false);
    expect(isReadOnlyMcpTool({ name: "write", metadata: { mcp: { serverToolName: "write", annotations: { readOnlyHint: false } } } })).toBe(false);
  });
});

describe("buildMcpTools", () => {
  it("exposes only read-only tools, prefixed, with the server-native name in metadata", async () => {
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([MCP_TOOL_FIXTURE, tool("write_thing", false), tool("no_annotation", undefined)]) }),
    });
    const names = (toolset.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["mcp__jev__read_docs"]);
    const wrapped = toolset.tools[0] as { metadata: { mcp: { serverToolName: string; serverId: string } } };
    expect(wrapped.metadata.mcp.serverToolName).toBe("read_docs");
    expect(wrapped.metadata.mcp.serverId).toBe("jev");
    await toolset.close();
  });

  it("fails open on a server whose discovery rejects, keeping healthy servers", async () => {
    const bad: McpClientFactory = { create: async () => { throw new Error("boom"); } };
    const toolset = await buildMcpTools({
      servers: [row({ id: "bad" }), row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: {
        create: async (r, opts) => (r.id === "bad" ? bad.create(r, opts) : handle([MCP_TOOL_FIXTURE])),
      },
    });
    expect((toolset.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["mcp__jev__read_docs"]);
    await toolset.close();
  });

  it("times out a slow server and skips it", async () => {
    const hang: McpClientFactory = { create: () => new Promise<McpClientHandle>(() => {}) };
    const started = Date.now();
    const toolset = await buildMcpTools({
      servers: [row({ id: "slow" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: hang,
      discoveryTimeoutMs: 5,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(toolset.tools).toEqual([]);
    await toolset.close();
  });

  it("times out a hanging tools() call and still closes the client", async () => {
    let closed = 0;
    const toolset = await buildMcpTools({
      servers: [row({ id: "hang" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ hang: { tools: () => new Promise<McpDiscoveredTool[]>(() => {}), close: async () => { closed += 1; } } }),
      discoveryTimeoutMs: 5,
    });
    expect(toolset.tools).toEqual([]);
    await toolset.close();
    expect(closed).toBe(1);
  });

  it("closes each client exactly once even when close is called twice", async () => {
    let closed = 0;
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([MCP_TOOL_FIXTURE], () => { closed += 1; }) }),
    });
    await Promise.all([toolset.close(), toolset.close()]);
    await toolset.close();
    expect(closed).toBe(1);
  });

  it("caps tool results and audits each call", async () => {
    const audits: McpToolCallAudit[] = [];
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, async () => "x".repeat(150_000))]) }),
      onToolCall: (entry) => audits.push(entry),
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    const result = await execute({}, undefined);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBe(100_000);
    expect(audits).toEqual([{ serverId: "jev", toolName: "read_docs", ok: true, durationMs: expect.any(Number) }]);
    await toolset.close();
  });

  it("audits a failed call and surfaces MCP_TOOL_CALL_FAILED", async () => {
    const audits: McpToolCallAudit[] = [];
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, async () => { throw new Error("upstream exploded"); })]) }),
      onToolCall: (entry) => audits.push(entry),
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    await expect(execute({}, undefined)).rejects.toMatchObject({ _tag: "McpToolCallFailed" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ serverId: "jev", toolName: "read_docs", ok: false, errorCode: "MCP_TOOL_CALL_ERROR" });
    await toolset.close();
  });

  it("enforces the per-call timeout", async () => {
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, () => new Promise(() => {}))]) }),
      toolCallTimeoutMs: 5,
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    await expect(execute({}, undefined)).rejects.toMatchObject({ _tag: "McpToolCallFailed" });
    await toolset.close();
  });

  it("is a no-op for a project with no enabled servers", async () => {
    const toolset = await buildMcpTools({ servers: [], projectId: "p1", env: {}, allowlist: null });
    expect(toolset.tools).toEqual([]);
    await toolset.close();
  });
});

describe("SSRF at connect", () => {
  it("rejects a blocked http url before any client is created", async () => {
    ssrfMock.block = true;
    await expect(validateMcpTransportUrl(row(), null)).rejects.toMatchObject({ _tag: "UrlBlocked" });
    const toolset = await buildMcpTools({ servers: [row({ id: "blocked" })], projectId: "p1", env: {}, allowlist: null });
    expect(toolset.tools).toEqual([]);
    await toolset.close();
    ssrfMock.block = false;
  });

  it("allows a validated http url", async () => {
    await expect(validateMcpTransportUrl(row(), null)).resolves.toBeUndefined();
  });
});

describe("MCP tools in the model request", () => {
  it("prefixed read-only tools reach gatewayStream.tools; non-read-only do not", async () => {
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([MCP_TOOL_FIXTURE, tool("write_thing", false)]) }),
    });
    let captured: unknown[] = [];
    const ctx = baseCtx(toolset.tools, (input) => {
      const passed = (input as { tools?: unknown[] }).tools;
      if (passed !== undefined) captured = passed;
      return (async function* () {
        yield { type: "RUN_FINISHED" } as unknown as StreamChunk;
      })();
    });
    const frames = await drain(buildStream(ctx));
    expect(frames.at(-1)?.type).toBe("done");
    const names = (captured as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("mcp__jev__read_docs");
    expect(names).not.toContain("mcp__jev__write_thing");
    await toolset.close();
  });
});
