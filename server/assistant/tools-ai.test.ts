import { describe, expect, it } from "vitest";
import {
  buildReadTools,
  buildWriteTools,
  READ_TOOL_NAMES,
  WRITE_TOOL_NAMES,
  type AssistantToolTransport,
  type ReadToolResponse,
  type WriteToolResponse,
} from "./tools-ai";
import { ASSISTANT_WRITE_TOOL_NAMES, parseWriteTools } from "./write-tools";

type AnyTool = { execute?: (args: unknown) => Promise<unknown> };

function makeTransport(over: Partial<AssistantToolTransport> = {}): AssistantToolTransport {
  return {
    read: async () => ({ ok: true, result: {} }),
    propose: async () => ({ ok: true, proposed: true, approvalId: "a1", batchId: "b1", seq: 0, name: "create_task" }),
    ...over,
  };
}

describe("tools-ai read tools", () => {
  it("exposes exactly the names in READ_TOOL_NAMES", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(READ_TOOL_NAMES) });
    expect(Object.keys(tools).sort()).toEqual([...READ_TOOL_NAMES].sort());
  });

  it("omits tools the caller did not mark available", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(["get_task"]) });
    expect(Object.keys(tools)).toEqual(["get_task"]);
  });

  it("forwards name and args to the transport and returns the result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = makeTransport({
      read: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, result: { task: { key: "LEX-1" } } };
      },
    });
    const tools = buildReadTools({ transport, available: new Set(["get_task"]) });
    const out = await (tools["get_task"] as AnyTool).execute!({ ref: "LEX-1" });
    expect(calls).toEqual([{ name: "get_task", args: { ref: "LEX-1" } }]);
    expect(out).toEqual({ task: { key: "LEX-1" } });
  });

  it("surfaces a transport failure as a recoverable { error } result", async () => {
    const transport = makeTransport({ read: async () => ({ ok: false, error: "task not found" }) });
    const tools = buildReadTools({ transport, available: new Set(["get_task"]) });
    const out = await (tools["get_task"] as AnyTool).execute!({ ref: "NOPE" });
    expect(out).toEqual({ error: "task not found" });
  });

  it("never calls the transport with a malformed read tool", () => {
    const tools = buildReadTools({ transport: makeTransport(), available: new Set(["bogus"]) });
    expect(tools["bogus"]).toBeUndefined();
  });
});

describe("tools-ai write tools", () => {
  it("the DO write-tool name set matches the Worker authority", () => {
    expect([...WRITE_TOOL_NAMES]).toEqual([...ASSISTANT_WRITE_TOOL_NAMES]);
  });

  it("builds only the enabled write tools", () => {
    const enabled = parseWriteTools("create_task, archive_task, bogus");
    const tools = buildWriteTools({ transport: makeTransport(), enabled });
    expect(Object.keys(tools).sort()).toEqual(["archive_task", "create_task"]);
  });

  it("forwards the proposal and returns the Worker result", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const transport = makeTransport({
      propose: async (name, args) => {
        calls.push({ name, args });
        return { ok: true, proposed: true, approvalId: "appr-1", batchId: "batch-1", seq: 2, name: "create_task" };
      },
    });
    const tools = buildWriteTools({ transport, enabled: ["create_task"] });
    const out = await (tools["create_task"] as AnyTool).execute!({ title: "Write docs" });
    expect(calls).toEqual([{ name: "create_task", args: { title: "Write docs" } }]);
    expect(out).toEqual({ ok: true, proposed: true, approvalId: "appr-1", batchId: "batch-1", seq: 2, name: "create_task" });
  });

  it("returns the Worker's refusal unchanged", async () => {
    const transport = makeTransport({
      propose: async () => ({ ok: false, proposed: false, error: "task 'X' not found" }),
    });
    const tools = buildWriteTools({ transport, enabled: ["update_task"] });
    const out = await (tools["update_task"] as AnyTool).execute!({ ref: "X", title: "Y" });
    expect(out).toEqual({ ok: false, proposed: false, error: "task 'X' not found" });
  });
});

describe("ReadToolResponse / WriteToolResponse shapes", () => {
  it("keeps the transport contracts discriminated", () => {
    const r: ReadToolResponse = { ok: true, result: 1 };
    const w: WriteToolResponse = { ok: false, proposed: false, error: "x" };
    expect(r.ok && w.ok).toBe(false);
  });
});
