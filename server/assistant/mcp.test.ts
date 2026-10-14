import { beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Exit } from "effect";
import type { McpServerRowWithSecret } from "../repos/assistant-mcp.repo";
import { type RuntimeEnv } from "../env";
import {
  acquireMcpToolset,
  buildMcpTools,
  isReadOnlyMcpTool,
  liveMcpClientFactory,
  validateMcpTransportUrl,
  type McpClientFactory,
  type McpClientHandle,
  type McpDiscoveredTool,
  type McpToolCallAudit,
  type McpToolset,
} from "./mcp";
import { encryptSecret, secretsKeyringFromEnv, SECRET_DECRYPT_FAILED } from "./secrets";

// Fixed connect refusals, duplicated from the module on purpose: a drift between
// the message and the test is a test failure, not a silent reword.
const SECRET_NOT_SINGLE_LINE = "resolved MCP secret cannot be sent in an HTTP header; use a single-line token";
const THIRD_PARTY_CONNECT_FAILURE = "MCP connect failed — remote error details are not forwarded";
const THIRD_PARTY_TOOL_CALL_FAILURE = "MCP tool call failed — remote error details are not forwarded";
// Managed-only: the legacy stored-reference hard failure and the no-key hard
// failure, both private consts in server/assistant/mcp.ts.
const SECRET_REF_UNSUPPORTED = "MCP secret references are no longer supported — store a managed token or clear the reference";
const SECRET_KEY_UNAVAILABLE = "MCP managed secret requires LXK_SECRETS_MASTER_KEY, which is not configured";

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

// No managed secret unless a test asks for one: the three blob columns are
// all-or-nothing in storage, and nulls mean "no ciphertext row" (the LEFT JOIN
// found nothing), which is the secret-less reference-or-nothing case.
function row(overrides: Partial<McpServerRowWithSecret> = {}): McpServerRowWithSecret {
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
    secret_ciphertext: null,
    secret_iv: null,
    secret_key_id: null,
    ...overrides,
  };
}

// Managed-secret fixtures: the token field is write-only, so a connect test has
// to build a real AES-GCM blob through the same module the connect path opens
// it with (bound to the server id by the AAD).
const MCP_TEST_KEY = Buffer.from("k".repeat(32)).toString("base64");
const MCP_TEST_KEY_OTHER = Buffer.from("m".repeat(32)).toString("base64");
const keyedEnv = (over: Partial<RuntimeEnv> = {}): RuntimeEnv =>
  ({ LXK_SECRETS_MASTER_KEY: MCP_TEST_KEY, ...over }) as unknown as RuntimeEnv;

async function sealedRow(secret: string, overrides: Partial<McpServerRowWithSecret> = {}): Promise<McpServerRowWithSecret> {
  const id = overrides.id ?? "fake";
  const keyring = await secretsKeyringFromEnv(keyedEnv());
  const sealed = await encryptSecret(secret, "mcp", id, keyring!.active, keyring!);
  return row({ ...overrides, id, secret_ciphertext: sealed.ciphertextB64, secret_iv: sealed.ivB64, secret_key_id: sealed.keyId });
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

describe("isReadOnlyMcpTool", () => {
  it("default-denies when the annotation is absent or false", () => {
    expect(isReadOnlyMcpTool({ name: "write" })).toBe(false);
    expect(isReadOnlyMcpTool({ name: "write", metadata: { mcp: { serverToolName: "write" } } })).toBe(false);
    expect(isReadOnlyMcpTool({ name: "write", metadata: { mcp: { serverToolName: "write", annotations: { readOnlyHint: false } } } })).toBe(false);
  });
});

describe("buildMcpTools", () => {
  it("exposes only read-only tools (default-deny) and caps tool results at 100k", async () => {
    const toolset = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([MCP_TOOL_FIXTURE, tool("write_thing", false), tool("no_annotation", undefined)]) }),
    });
    // Default-deny: only the read-only tool reaches the toolset.
    const names = (toolset.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(["mcp__jev__read_docs"]);

    const capped = await buildMcpTools({
      servers: [row({ id: "jev" })],
      projectId: "p1",
      env: {},
      allowlist: null,
      connector: factory({ jev: handle([tool("read_docs", true, async () => "x".repeat(150_000))]) }),
    });
    const execute = (capped.tools[0] as { execute: (args: unknown, ctx?: unknown) => Promise<unknown> }).execute;
    const result = await execute({}, undefined);
    expect(typeof result).toBe("string");
    expect((result as string).length).toBe(100_000);
    await toolset.close();
    await capped.close();
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
    expect(audits[0]).toMatchObject({ serverId: "jev", ok: false, errorCode: "MCP_TOOL_CALL_ERROR" });
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

  it("closes eventual discovery after interruption and transfers successful ownership through cancellation at handoff", async () => {
    for (const phase of ["discovery", "handoff", "normal"] as const) {
      const entered = Promise.withResolvers<void>();
      const discovery = Promise.withResolvers<McpDiscoveredTool[]>();
      const disposed = Promise.withResolvers<void>();
      let closes = 0;
      const client: McpClientHandle = {
        tools: () => {
          entered.resolve();
          return discovery.promise;
        },
        close: async () => {
          closes++;
          disposed.resolve();
        },
      };
      const abort = new AbortController();
      let owned: McpToolset | undefined;
      const completion = Effect.runPromiseExit(acquireMcpToolset(
        () => buildMcpTools({
          servers: [row({ id: "jev" })],
          projectId: "p1",
          env: {},
          allowlist: null,
          connector: factory({ jev: client }),
        }),
        (toolset) => {
          owned = toolset;
          if (phase === "handoff") abort.abort();
        }
      ), { signal: abort.signal });
      await entered.promise;
      if (phase === "discovery") {
        abort.abort();
        expect(Exit.isInterrupted(await completion)).toBe(true);
        expect(closes).toBe(0);
        expect(owned).toBe(undefined);
        discovery.resolve([MCP_TOOL_FIXTURE]);
        await disposed.promise;
      } else {
        discovery.resolve([MCP_TOOL_FIXTURE]);
        const outcome = await completion;
        if (phase === "normal") expect(Exit.isSuccess(outcome)).toBe(true);
        expect(closes).toBe(0);
        expect(owned?.tools.length).toBe(1);
        await owned!.close();
        await owned!.close();
      }
      expect(closes).toBe(1);
    }
  });

  it("closes a factory handle arriving after discovery timeout, before or after toolset disposal", async () => {
    for (const disposeFirst of [false, true]) {
      const created = Promise.withResolvers<McpClientHandle>();
      const disposed = Promise.withResolvers<void>();
      let closes = 0;
      let discoveries = 0;
      const client: McpClientHandle = {
        tools: async () => {
          discoveries++;
          return [MCP_TOOL_FIXTURE];
        },
        close: async () => {
          closes++;
          disposed.resolve();
        },
      };
      const toolset = await buildMcpTools({
        servers: [row({ id: "jev" })],
        projectId: "p1",
        env: {},
        allowlist: null,
        connector: { create: () => created.promise },
        discoveryTimeoutMs: 5,
      });
      if (disposeFirst) await toolset.close();
      created.resolve(client);
      await disposed.promise;
      await toolset.close();
      expect(toolset.tools).toEqual([]);
      expect(discoveries).toBe(0);
      expect(closes).toBe(1);
    }
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
});

// 0010 deletes every stored stdio row; these rows can only be reproduced by
// hand, so this is the regression guard for "no local process, ever".
function legacyStdioRow(overrides: Partial<McpServerRowWithSecret> = {}): McpServerRowWithSecret {
  return row({ id: "legacy", transport_type: "stdio", url: null, command: "legacy-mcp", args: '["--stdio"]', ...overrides });
}

describe("transport guard (no local process)", () => {
  it("refuses a legacy stdio row before any client is created, never as the reserved stdio code", async () => {
    const err = await liveMcpClientFactory.create(legacyStdioRow(), { env: {}, allowlist: null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ _tag: "McpConnectFailed" });
    expect((err as { _tag: string })._tag).not.toBe("McpStdioUnavailable");
    expect(sdkMock.calls).toEqual([]);
  });
});

describe("managed remote auth", () => {
  async function connect(env: RuntimeEnv, r: McpServerRowWithSecret): Promise<Record<string, unknown>> {
    await liveMcpClientFactory.create(r, { env, allowlist: null });
    return sdkMock.calls[0]!.transport as Record<string, unknown>;
  }

  it("sends only Authorization: Bearer for a managed token, and hard-fails every other credential instead of connecting anonymously", async () => {
    const transport = await connect(keyedEnv(), await sealedRow("managed-secret"));
    expect(transport).toEqual({ type: "http", url: "https://mcp.test/mcp", headers: { Authorization: "Bearer managed-secret" } });

    // Managed-only (2026-09-28): a stored `secret_ref` is no longer a credential.
    // Hard-fail rather than connect anonymously — an unauthenticated client is
    // indistinguishable from a working one.
    sdkMock.calls = [];
    const refErr = await liveMcpClientFactory
      .create(row({ secret_ref: "env:MCP_REMOTE_TOKEN" }), { env: keyedEnv(), allowlist: null })
      .catch((e: unknown) => e);
    expect(refErr).toMatchObject({ _tag: "McpConnectFailed", message: SECRET_REF_UNSUPPORTED });
    expect(sdkMock.calls).toEqual([]);

    // A managed blob with no master key configured.
    const noKeyErr = await liveMcpClientFactory
      .create(await sealedRow("managed-secret"), { env: {}, allowlist: null })
      .catch((e: unknown) => e);
    expect(noKeyErr).toMatchObject({ _tag: "McpConnectFailed", message: SECRET_KEY_UNAVAILABLE });
    expect(sdkMock.calls).toEqual([]);

    // A managed blob under a master key that cannot decrypt it.
    const undecryptable = await sealedRow("managed-secret");
    const badKeyErr = await liveMcpClientFactory
      .create(undecryptable, { env: { LXK_SECRETS_MASTER_KEY: MCP_TEST_KEY_OTHER } as unknown as RuntimeEnv, allowlist: null })
      .catch((e: unknown) => e);
    expect(badKeyErr).toMatchObject({ _tag: "McpConnectFailed", message: SECRET_DECRYPT_FAILED });
    expect(sdkMock.calls).toEqual([]);
  });

  it("keeps the secret out of the connect error and the discovery log", async () => {
    sdkMock.failWith = new Error("connect ECONNREFUSED");
    const logged: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      logged.push(String(chunk));
      return true;
    });
    try {
      const toolset = await buildMcpTools({ servers: [await sealedRow("leaky-secret")], projectId: "p1", env: keyedEnv(), allowlist: null });
      expect(toolset.tools).toEqual([]);
      await toolset.close();
    } finally {
      spy.mockRestore();
    }
    expect(logged.join("\n")).not.toContain("leaky-secret");
    expect(logged.join("\n")).not.toContain(MCP_TEST_KEY);

    // A decrypted secret with CR/LF/NUL cannot become a header value: fetch
    // rejects it with a TypeError whose message quotes the value verbatim. The
    // value is refused BEFORE it reaches the factory/SDK, with a message naming
    // no secret.
    sdkMock.calls = [];
    const pem = "-----BEGIN PRIVATE KEY-----\nleaky-pem-body\n-----END PRIVATE KEY-----";
    const multilineErr = await liveMcpClientFactory
      .create(await sealedRow(pem), { env: keyedEnv(), allowlist: null })
      .catch((e: unknown) => e);
    expect(multilineErr).toMatchObject({ _tag: "McpConnectFailed" });
    const multilineMessage = (multilineErr as { message?: string }).message ?? "";
    expect(multilineMessage).toBe(SECRET_NOT_SINGLE_LINE);
    expect(multilineMessage).not.toContain("leaky-pem-body");
    expect(multilineMessage).not.toContain("BEGIN PRIVATE KEY");
    expect(sdkMock.calls).toEqual([]);
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
});
