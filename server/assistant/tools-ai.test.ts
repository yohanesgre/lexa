import { describe, expect, it, vi } from "vitest";
import { buildMcpToolSet, type AssistantToolTransport } from "./tools-ai";

function transport(read: AssistantToolTransport["read"]): AssistantToolTransport {
  return { read, propose: vi.fn(), execute: vi.fn() } as unknown as AssistantToolTransport;
}

describe("buildMcpToolSet", () => {
  it("builds one tool per descriptor and dispatches by prefixed name", async () => {
    const read = vi.fn(async () => ({ ok: true, result: "R" }));
    const tools = buildMcpToolSet(
      [
        { name: "mcp__srv__read", description: "reads", inputSchema: { type: "object" } },
        { name: "mcp__srv__list", description: "lists", inputSchema: { type: "object" } },
      ],
      transport(read)
    );
    expect(Object.keys(tools).sort()).toEqual(["mcp__srv__list", "mcp__srv__read"]);
    const tool = tools["mcp__srv__read"] as { execute: (args: unknown) => Promise<unknown> };
    await expect(tool.execute({ q: 1 })).resolves.toBe("R");
    expect(read).toHaveBeenCalledWith("mcp__srv__read", { q: 1 });
  });

  it("drops non-prefixed names, duplicate names, and tolerates a non-object schema", () => {
    const tools = buildMcpToolSet(
      [
        { name: "not_mcp", description: "x", inputSchema: {} },
        { name: "mcp__srv__read", description: "reads", inputSchema: "not-an-object" },
        { name: "mcp__srv__read", description: "dup", inputSchema: {} },
      ],
      transport(vi.fn(async () => ({ ok: true })))
    );
    expect(Object.keys(tools)).toEqual(["mcp__srv__read"]);
  });
});
