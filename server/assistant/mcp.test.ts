import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer } from "effect";
import type { StreamChunk } from "@tanstack/ai";
import { MAX_CHAT_TOOL_ROUNDS } from "./tools";
import type { McpServerRow } from "../repos/assistant-mcp.repo";
import { McpConnector } from "../services/assistant-mcp.service";
import { getEnvFromWorkers, type RuntimeEnv } from "../env";
import type { StreamFrame } from "../../shared/assistant";
import {
  buildMcpTools,
  isReadOnlyMcpTool,
  liveMcpClientFactory,
  LiveMcpConnector,
  mcpToolPrefix,
  MCP_TOOL_NAME_MAX,
  parsePrefixedMcpToolName,
  prefixedMcpToolName,
  sanitizeMcpServerId,
  UNSUPPORTED_TRANSPORT_REASON,
  validateMcpTransportUrl,
  type McpClientFactory,
  type McpClientHandle,
  type McpDiscoveredTool,
  type McpToolCallAudit,
} from "./mcp";
import { buildStream, type StreamRunContext } from "./build-stream";

const providerMock = vi.hoisted(() => ({ script: [] as Array<Record<string, unknown>> }));

// Fixed connect refusals, duplicated from the module on purpose: a drift between
// the message and the test is a test failure, not a silent reword.
const SECRET_NOT_SINGLE_LINE = "resolved MCP secret cannot be sent in an HTTP header; use a single-line token";
const THIRD_PARTY_CONNECT_FAILURE = "MCP connect failed — remote error details are not forwarded";
const THIRD_PARTY_TOOL_CALL_FAILURE = "MCP tool call failed — remote error details are not forwarded";

// Transport capture: the live factory is the only caller of `createMCPClient`, so
// stubbing it observes the exact transport config handed to ai-mcp 0.4.6 without
// dialing a server or spawning a process.
const sdkMock = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
  failWith: null as unknown,
  failToolsWith: null as Error | null,
  tools: [] as Array<Record<string, unknown>>,
}));
vi.mock("@tanstack/ai-mcp", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/ai-mcp")>();
  return {
    ...actual,
    createMCPClient: (async (options: Record<string, unknown>) => {
      sdkMock.calls.push(options);
      if (sdkMock.failWith) throw sdkMock.failWith;
      return {
        tools: async () => {
          if (sdkMock.failToolsWith) throw sdkMock.failToolsWith;
          return sdkMock.tools;
        },
        close: async () => {},
      };
    }) as unknown as typeof actual.createMCPClient,
  };
});

beforeEach(() => {
  sdkMock.calls = [];
  sdkMock.failWith = null;
  sdkMock.failToolsWith = null;
  sdkMock.tools = [];
});

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

  // A discovery failure is logged with a redacted third-party message, so the
  // server id is the ONLY thing that tells the operator which client failed.
  it("attributes a discovery skip to the failing server id", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({
        servers: [row({ id: "good" }), row({ id: "broken" })],
        projectId: "p1",
        env: {},
        allowlist: null,
        connector: {
          create: async (r) => {
            if (r.id === "broken") throw new Error("remote JSON-RPC error: boom");
            return handle([MCP_TOOL_FIXTURE]);
          },
        },
      });
      expect((toolset.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["mcp__good__read_docs"]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    const discoveryLines = logged
      .map((line) => JSON.parse(line) as { message?: string; meta?: { reason?: string; serverId?: string; error?: string } })
      .filter((entry) => entry.meta?.reason === "discovery");
    expect(discoveryLines).toHaveLength(1);
    expect(discoveryLines[0]!.meta!.serverId).toBe("broken");
    expect(discoveryLines[0]!.meta!.error).toBe(THIRD_PARTY_CONNECT_FAILURE);
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

  // The tool-call wrapper is the last place remote text used to escape: a
  // thrown Error's message was copied verbatim into McpToolCallFailed, which
  // reaches the model as a tool result and the stream as an error frame. A
  // remote echoing the Authorization header puts the token there.
  it("replaces a third-party tool error with a fixed message, keeping the audit code", async () => {
    const audits: McpToolCallAudit[] = [];
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({
        jev: handle([
          tool("read_docs", true, async () => {
            throw new Error("upstream said: Authorization: Bearer sk-live-FAKESECRET");
          }),
        ]),
      }),
      onToolCall: (entry) => audits.push(entry),
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    const err = await execute({}, undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ _tag: "McpToolCallFailed", message: THIRD_PARTY_TOOL_CALL_FAILURE });
    expect((err as { message: string }).message).not.toContain("FAKESECRET");
    expect((err as { message: string }).message).not.toContain("Bearer");
    // The audit sink still distinguishes a Lexa refusal from a remote throw.
    expect(audits[0]).toMatchObject({ serverId: "jev", ok: false, errorCode: "MCP_TOOL_CALL_ERROR" });
    await toolset.close();
  });

  it("replaces a non-Error tool throw with the same fixed message", async () => {
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, () => { throw "raw sk-live-FAKESECRET"; })]) }),
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    const err = await execute({}, undefined).catch((e: unknown) => e);
    expect((err as { message: string }).message).toBe(THIRD_PARTY_TOOL_CALL_FAILURE);
    await toolset.close();
  });

  it("keeps a Lexa-constructed tool refusal readable", async () => {
    const audits: McpToolCallAudit[] = [];
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, async () => "ok")]) }),
      onToolCall: (entry) => audits.push(entry),
      toolCallTimeoutMs: 5,
    });
    const execute = (toolset.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    // The timeout rejection is an McpToolCallFailed Lexa built: its text names
    // the tool and the budget, which is the actionable part.
    const slow = await buildMcpTools({
      servers: [row({ id: "jev2" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev2: handle([tool("read_docs", true, () => new Promise(() => {}))]) }),
      toolCallTimeoutMs: 5,
    });
    const slowExecute = (slow.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    const err = await slowExecute({}, undefined).catch((e: unknown) => e);
    expect(err).toMatchObject({ _tag: "McpToolCallFailed" });
    expect((err as { message: string }).message).toBe("MCP tool mcp__jev2__read_docs exceeded 5 ms");

    // A discovered tool with no execute is the other Lexa-built refusal.
    const noExecuteTool: McpDiscoveredTool = { ...MCP_TOOL_FIXTURE };
    delete noExecuteTool.execute;
    const noExecute = (await buildMcpTools({
      servers: [row({ id: "jev3" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev3: handle([noExecuteTool]) }),
    })).tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> };
    const missing = await noExecute.execute({}, undefined).catch((e: unknown) => e);
    expect((missing as { message: string }).message).toBe("MCP tool mcp__jev3__read_docs has no executable definition");
    expect(execute).toBeTypeOf("function");
    await toolset.close();
    await slow.close();
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

// 0010 deletes every stored stdio row; these rows can only be reproduced by
// hand, so this is the regression guard for "no local process, ever".
function legacyStdioRow(overrides: Partial<McpServerRow> = {}): McpServerRow {
  return row({ id: "legacy", transport_type: "stdio", url: null, command: "legacy-mcp", args: '["--stdio"]', ...overrides });
}

describe("transport guard (no local process)", () => {
  it("refuses a legacy stdio row before any client is created, never as the reserved stdio code", async () => {
    const err = await liveMcpClientFactory.create(legacyStdioRow(), { env: {}, allowlist: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ _tag: "McpConnectFailed" });
    expect((err as { _tag: string })._tag).not.toBe("McpStdioUnavailable");
    expect(sdkMock.calls).toEqual([]);
  });

  it("skips a legacy stdio row in buildMcpTools without reaching the factory", async () => {
    let created = 0;
    const spy: McpClientFactory = {
      create: async () => {
        created += 1;
        return handle([MCP_TOOL_FIXTURE]);
      },
    };
    const toolset = await buildMcpTools({
      servers: [legacyStdioRow(), row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: spy,
    });
    expect(created).toBe(1);
    expect((toolset.tools as Array<{ name: string }>).map((t) => t.name)).toEqual(["mcp__jev__read_docs"]);
    await toolset.close();
  });

  it("connects http and sse rows (the only supported transports)", async () => {
    for (const transport of ["http", "sse"] as const) {
      await liveMcpClientFactory.create(row({ id: transport, transport_type: transport, url: `https://mcp.test/${transport}` }), { env: {}, allowlist: null });
    }
    expect(sdkMock.calls.map((c) => (c.transport as { type: string }).type)).toEqual(["http", "sse"]);
  });
});

describe("remote bearer auth", () => {
  let dir: string;
  let secretFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "lexa-mcp-bearer-"));
    secretFile = join(dir, "token");
    writeFileSync(secretFile, "file-secret\n");
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function connect(env: RuntimeEnv, overrides: Partial<McpServerRow> = {}): Promise<Record<string, unknown>> {
    await liveMcpClientFactory.create(row({ secret_ref: "env:MCP_REMOTE_TOKEN", ...overrides }), { env, allowlist: null });
    return sdkMock.calls[0]!.transport as Record<string, unknown>;
  }

  it("sends only Authorization: Bearer for an env reference", async () => {
    const env = { MCP_REMOTE_TOKEN: "env-secret" } as unknown as RuntimeEnv;
    expect(await connect(env)).toEqual({ type: "http", url: "https://mcp.test/mcp", headers: { Authorization: "Bearer env-secret" } });
  });

  it("resolves a secret carried by the Workers RuntimeEnv snapshot", async () => {
    const env = getEnvFromWorkers({ LXK_ENV: "prod", GITHUB_WEBHOOK_SECRET: "workers-secret" });
    const transport = await connect(env, { secret_ref: "env:GITHUB_WEBHOOK_SECRET" });
    expect(transport).toEqual({ type: "http", url: "https://mcp.test/mcp", headers: { Authorization: "Bearer workers-secret" } });
  });

  it("sends no header for a Workers binding the RuntimeEnv snapshot does not carry", async () => {
    // getEnvFromWorkers is an explicit allowlist, so a binding outside it never
    // reaches the resolver: fail closed (no Authorization) rather than guess.
    const transport = await connect(getEnvFromWorkers({ MCP_REMOTE_TOKEN: "workers-secret" }));
    expect("headers" in transport).toBe(false);
  });

  it("resolves a file reference (Bun host)", async () => {
    const transport = await connect({}, { secret_ref: `file:${secretFile}` });
    expect(transport.headers).toEqual({ Authorization: "Bearer file-secret" });
  });

  it("omits headers entirely when no secret is configured", async () => {
    const transport = await connect({}, { secret_ref: null });
    expect(transport).toEqual({ type: "http", url: "https://mcp.test/mcp" });
    expect("headers" in transport).toBe(false);
  });

  // A zero-byte or whitespace-only file resolves to "", and the header was
  // then built as `Authorization: "Bearer "` — an empty bearer that some
  // servers read as anonymous rather than as "no credential". The `env:` branch
  // already fails closed on an empty value; `file:` must match it.
  it("omits headers for an empty or whitespace-only secret file", async () => {
    for (const [name, contents] of [["empty", ""], ["blank", "  \n\t\n "]] as const) {
      const path = join(dir, name);
      writeFileSync(path, contents);
      const transport = await connect({}, { secret_ref: `file:${path}` });
      expect("headers" in transport, name).toBe(false);
    }
  });

  it("omits headers when the reference cannot be resolved", async () => {
    const transport = await connect({}, { secret_ref: "env:MCP_MISSING" });
    expect("headers" in transport).toBe(false);
    const unreadable = await connect({}, { secret_ref: `file:${join(dir, "absent")}` });
    expect("headers" in unreadable).toBe(false);
  });

  it("never falls back to process.env for a named reference", async () => {
    process.env.MCP_REMOTE_TOKEN = "host-secret";
    try {
      const transport = await connect({});
      expect("headers" in transport).toBe(false);
    } finally {
      delete process.env.MCP_REMOTE_TOKEN;
    }
  });

  it("sends Bearer for an sse transport too", async () => {
    const transport = await connect({ MCP_REMOTE_TOKEN: "sse-secret" } as unknown as RuntimeEnv, {
      transport_type: "sse",
      url: "https://mcp.test/sse",
    });
    expect(transport).toEqual({ type: "sse", url: "https://mcp.test/sse", headers: { Authorization: "Bearer sse-secret" } });
  });

  it("keeps the secret out of the connect error and the discovery log", async () => {
    const env = { MCP_REMOTE_TOKEN: "leaky-secret" } as unknown as RuntimeEnv;
    sdkMock.failWith = new Error("connect ECONNREFUSED");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({ servers: [row({ secret_ref: "env:MCP_REMOTE_TOKEN" })], projectId: "p1", env, allowlist: null });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).not.toContain("leaky-secret");
    expect(logged.join("\n")).not.toContain("MCP_REMOTE_TOKEN");
  });

  // The skip log is the other stderr sink for a connect failure, so third-party
  // SDK/remote text must be replaced there too — a remote JSON-RPC error can
  // quote the header or the response body.
  it("logs a third-party connect failure without its message", async () => {
    sdkMock.failWith = new Error("remote JSON-RPC error: Bearer sk-live-FAKESECRET rejected");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({ servers: [row()], projectId: "p1", env: {}, allowlist: null });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    const stderr = logged.join("\n");
    expect(stderr).not.toContain("FAKESECRET");
    expect(stderr).not.toContain("JSON-RPC");
    expect(stderr).toContain(THIRD_PARTY_CONNECT_FAILURE);
  });

  it("keeps a Lexa-constructed refusal readable in the skip log", async () => {
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({ servers: [row({ secret_ref: "env:MCP_REMOTE_TOKEN" })], projectId: "p1", env: { MCP_REMOTE_TOKEN: "a\nb" } as unknown as RuntimeEnv, allowlist: null });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).toContain(SECRET_NOT_SINGLE_LINE);
  });

  it("does not leak the secret through a failed tools/list", async () => {
    const env = { MCP_REMOTE_TOKEN: "leaky-secret" } as unknown as RuntimeEnv;
    sdkMock.failToolsWith = new Error("tools/list failed");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({ servers: [row({ secret_ref: "env:MCP_REMOTE_TOKEN" })], projectId: "p1", env, allowlist: null });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).not.toContain("leaky-secret");
  });

  // A resolved secret with CR/LF/NUL cannot become a header value: Bun's fetch
  // rejects it with a TypeError whose message quotes the value verbatim, which
  // would then reach stderr (logMcpSkip) and the test-report body. The value is
  // refused BEFORE it reaches the factory/SDK, with a message naming no secret.
  it("refuses a multiline resolved secret before it reaches the SDK, with no secret in the message", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nleaky-pem-body\n-----END PRIVATE KEY-----";
    const env = { MCP_REMOTE_TOKEN: pem } as unknown as RuntimeEnv;
    const err = await liveMcpClientFactory
      .create(row({ secret_ref: "env:MCP_REMOTE_TOKEN" }), { env, allowlist: null })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ _tag: "McpConnectFailed" });
    const message = (err as { message?: string }).message ?? "";
    expect(message).toBe(SECRET_NOT_SINGLE_LINE);
    expect(message).not.toContain("leaky-pem-body");
    expect(message).not.toContain("BEGIN PRIVATE KEY");
    expect(sdkMock.calls).toEqual([]);
  });

  it("refuses a NUL-bearing secret and a multiline file: secret the same way", async () => {
    const nulEnv = { MCP_REMOTE_TOKEN: "tok\0en" } as unknown as RuntimeEnv;
    const nulErr = await liveMcpClientFactory
      .create(row({ secret_ref: "env:MCP_REMOTE_TOKEN" }), { env: nulEnv, allowlist: null })
      .catch((e: unknown) => e);
    expect(nulErr).toMatchObject({ _tag: "McpConnectFailed", message: SECRET_NOT_SINGLE_LINE });

    const pemFile = join(dir, "pem");
    writeFileSync(pemFile, "-----BEGIN KEY-----\nleaky-file-body\n-----END KEY-----\n");
    const fileErr = await liveMcpClientFactory
      .create(row({ secret_ref: `file:${pemFile}` }), { env: {}, allowlist: null })
      .catch((e: unknown) => e);
    expect(fileErr).toMatchObject({ _tag: "McpConnectFailed" });
    expect((fileErr as { message?: string }).message).not.toContain("leaky-file-body");
    expect(sdkMock.calls).toEqual([]);
  });

  it("logs a refused multiline secret without a single secret byte", async () => {
    const env = { MCP_REMOTE_TOKEN: "token-head\nleaky-tail\n" } as unknown as RuntimeEnv;
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({
        servers: [row({ secret_ref: "env:MCP_REMOTE_TOKEN" })],
        projectId: "p1",
        env,
        allowlist: null,
      });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    const stderr = logged.join("\n");
    expect(stderr).not.toContain("token-head");
    expect(stderr).not.toContain("leaky-tail");
    expect(stderr).toContain(SECRET_NOT_SINGLE_LINE);
  });
});

// The test endpoint and the tool bridge both surface a connect failure; the
// message is the only part a superadmin sees, so it must never carry remote
// text (a JSON-RPC error, a fetch TypeError quoting the header, an SDK stack).
describe("connect error forwarding (LiveMcpConnector)", () => {
  async function liveConnect(r: McpServerRow, env: RuntimeEnv = {}): Promise<unknown> {
    const ctx = await Effect.runPromise(Effect.scoped(Layer.build(LiveMcpConnector)));
    const connector = Context.get(ctx, McpConnector);
    return Effect.runPromise(connector.connect(r, { env, allowlist: null }).pipe(Effect.flip));
  }

  it("replaces third-party Error text with a fixed generic message", async () => {
    sdkMock.failWith = new TypeError("fetch failed: Bearer sk-live-FAKESECRET not allowed\r\n");
    const err = await liveConnect(row({ secret_ref: "env:MCP_REMOTE_TOKEN" }));
    expect(err).toMatchObject({ _tag: "McpConnectFailed" });
    const message = (err as { message?: string }).message ?? "";
    expect(message).toBe(THIRD_PARTY_CONNECT_FAILURE);
    expect(message).not.toContain("FAKESECRET");
    expect(message).not.toContain("fetch failed");
  });

  it("replaces a non-Error throw with the same generic message", async () => {
    sdkMock.failWith = "remote said sk-live-FAKESECRET";
    const err = await liveConnect(row());
    expect((err as { message?: string }).message).toBe(THIRD_PARTY_CONNECT_FAILURE);
  });

  it("passes a Lexa-constructed refusal through unchanged", async () => {
    const err = await liveConnect(legacyStdioRow());
    expect(err).toMatchObject({ _tag: "McpConnectFailed" });
    expect((err as { message?: string }).message).toBe(
      `MCP server 'legacy': ${UNSUPPORTED_TRANSPORT_REASON}`
    );
  });

  it("passes the refused-multiline-secret message through unchanged", async () => {
    const env = { MCP_REMOTE_TOKEN: "a\nb" } as unknown as RuntimeEnv;
    const err = await liveConnect(row({ secret_ref: "env:MCP_REMOTE_TOKEN" }), env);
    expect((err as { message?: string }).message).toBe(SECRET_NOT_SINGLE_LINE);
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
